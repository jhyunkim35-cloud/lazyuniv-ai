"""Notyx U7b — local speaker-diarization worker.

Polls Firestore `diarizationJobs/{jobId}` for pending jobs (enqueued by
api/whisper-stt.js), downloads the recording, converts it to 16kHz mono WAV,
runs pyannote community-1 diarization, and writes the resulting speaker turns
back onto the job doc. Groq Whisper transcription happens synchronously in
the serverless function; this worker only produces the speaker labels that
get merged in later (see api/whisper-stt.js `status`/`labels` actions and
api/_stt_merge.js).

Run: python diarize_worker.py   (no CLI args; loops forever)
Self-check: python diarize_worker.py selftest
"""
import os
import sys
import time
import shutil
import tempfile
import subprocess
import traceback
import wave

import functools

import numpy as np
import requests
import firebase_admin
from firebase_admin import credentials, firestore

# Logs must survive piped/background execution — Python buffers stdout when
# it's not a TTY, which hid job-completion lines during the loopback test.
print = functools.partial(print, flush=True)


# Block idle-sleep while a job is diarizing (a 65-min lecture froze for 3+
# hours overnight when the laptop slept mid-job). Only holds during active
# processing — idle polling lets the machine sleep normally. Windows only;
# doesn't stop lid-close sleep, just idle timeout.
def keep_awake(on):
    if os.name != 'nt':
        return
    import ctypes
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    ctypes.windll.kernel32.SetThreadExecutionState(
        ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))

# ── Config ───────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ACCOUNT_JSON = os.environ.get('SERVICE_ACCOUNT_JSON', os.path.join(HERE, 'serviceAccount.json'))
POLL_SECONDS = 30
RECLAIM_HOURS = 3
MERGE_GAP_S = 0.5       # merge consecutive same-speaker turns closer than this
MAX_TURNS = 5000        # Firestore 1MB doc guard — ponytail: widen the merge
                         # gap and re-merge until the turn list fits comfortably.

# ffmpeg is installed via winget on this machine, which doesn't always land
# on PATH for a plain `python foo.py` launch — extend defensively so
# subprocess finds it regardless of how this script was started.
_winget_links = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'WinGet', 'Links')
if _winget_links and _winget_links not in os.environ.get('PATH', ''):
    os.environ['PATH'] = os.environ.get('PATH', '') + os.pathsep + _winget_links


def _load_hf_token():
    tok = os.environ.get('HF_TOKEN')
    if tok:
        return tok
    # ponytail: no .env parser dependency for one key — read the line by hand.
    env_path = os.path.join(HERE, '..', '.env.harness.local')
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('HF_TOKEN='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


HF_TOKEN = _load_hf_token()

# U7d sweep (worker/evalset, 2026-07-11): clustering.threshold 0.6→0.65 cut
# mean DER 23.1%→19.1% on the synthetic Korean dev set — the entire gain is
# on the overlap-heavy conversation (38.2%→22.1%, over-split 5→4 speakers) —
# and holds speaker counts on real audio (매불쇼 3, 세바시 1). Other knobs
# (Fa 0.04, min_duration_off) looked good on synthetic but ATE a real speaker
# → rejected. Re-derive with evalset/modal_sweep.py before changing.
TUNED_PARAMS = {
    'segmentation': {'min_duration_off': 0.0},
    'clustering': {'threshold': 0.65, 'Fa': 0.07, 'Fb': 0.8},
}


def init_firebase():
    if not firebase_admin._apps:
        cred = credentials.Certificate(SERVICE_ACCOUNT_JSON)
        firebase_admin.initialize_app(cred)
    return firestore.client()


_pipeline = None


def get_pipeline():
    """Load the pyannote pipeline once, lazily, on first job (multi-second
    model load — no reason to pay it before there's work)."""
    global _pipeline
    if _pipeline is None:
        if not HF_TOKEN:
            raise RuntimeError('HF_TOKEN not set (env var or ../.env.harness.local)')
        from pyannote.audio import Pipeline
        print('[worker] loading pyannote/speaker-diarization-community-1 ...')
        _pipeline = Pipeline.from_pretrained('pyannote/speaker-diarization-community-1', token=HF_TOKEN)
        _pipeline.instantiate(TUNED_PARAMS)
        print('[worker] pipeline loaded (tuned)')
    return _pipeline


# ── Job queue ────────────────────────────────────────────────────────────

def claim_job(db):
    """Find one claimable job — any pending, or a 'running' job stuck past
    RECLAIM_HOURS (worker crashed mid-job) — and atomically flip it to
    'running'. Returns (job_id, job_dict) or None if nothing to do or the
    claim raced with another worker.

    ponytail: no order_by on the pending query — equality-only filters use
    Firestore's automatic index, so no manual composite-index ops step.
    Strict FIFO doesn't matter at this volume; completed jobs leave the set.
    """
    jobs = db.collection('diarizationJobs')

    pending = list(jobs.where('status', '==', 'pending').limit(1).stream())
    candidate = pending[0] if pending else None

    if candidate is None:
        cutoff = time.time() - RECLAIM_HOURS * 3600
        for doc in jobs.where('status', '==', 'running').limit(20).stream():
            started = doc.to_dict().get('startedAt')
            started_s = started.timestamp() if hasattr(started, 'timestamp') else 0
            if started_s < cutoff:
                candidate = doc
                break

    if candidate is None:
        return None

    ref = jobs.document(candidate.id)

    @firestore.transactional
    def _claim(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists or snap.to_dict().get('status') not in ('pending', 'running'):
            return False
        tx.update(ref, {'status': 'running', 'startedAt': firestore.SERVER_TIMESTAMP})
        return True

    if not _claim(db.transaction()):
        return None  # another worker won the race
    return candidate.id, ref.get().to_dict()


# ── Audio pipeline ───────────────────────────────────────────────────────

def download_audio(url, dest_dir):
    r = requests.get(url, timeout=180)
    r.raise_for_status()
    src_path = os.path.join(dest_dir, 'in')
    with open(src_path, 'wb') as f:
        f.write(r.content)
    return src_path


def convert_to_wav(src_path, dest_dir):
    wav_path = os.path.join(dest_dir, 'out.wav')
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', src_path, '-ac', '1', '-ar', '16000', wav_path],
        check=True,
    )
    return wav_path


def load_waveform(wav_path):
    # ponytail: torchcodec's Windows wheel ships without the ffmpeg DLLs it
    # needs, so pyannote 4.x's default file-path decoding (which routes
    # through torchcodec) fails even for our own freshly-converted 16kHz
    # mono WAV. Read the PCM directly with stdlib `wave` and hand pyannote
    # an in-memory {'waveform','sample_rate'} dict instead — that path
    # bypasses torchcodec entirely. Deliberate; don't "fix" this back to
    # pipeline(wav_path), it will break on this machine.
    import torch
    with wave.open(wav_path, 'rb') as w:
        assert w.getnchannels() == 1 and w.getframerate() == 16000 and w.getsampwidth() == 2, \
            'expected mono 16kHz PCM16 wav from ffmpeg conversion'
        n_frames = w.getnframes()
        pcm = np.frombuffer(w.readframes(n_frames), dtype=np.int16)
        duration = n_frames / 16000.0
    waveform = torch.from_numpy(pcm.astype(np.float32) / 32768.0).unsqueeze(0)  # (1, time)
    return {'waveform': waveform, 'sample_rate': 16000}, duration


def extract_turns(output):
    ann = getattr(output, 'exclusive_speaker_diarization', None) or output.speaker_diarization
    turns = []
    if hasattr(ann, 'itertracks'):
        for seg, _, label in ann.itertracks(yield_label=True):
            turns.append({'start': round(seg.start, 3), 'end': round(seg.end, 3), 'speaker': str(label)})
    else:
        # Fallback for Annotation-like objects only iterable as (turn, speaker) pairs.
        for turn, speaker in ann:
            turns.append({'start': round(turn.start, 3), 'end': round(turn.end, 3), 'speaker': str(speaker)})
    return turns


def merge_turns(turns, gap_s):
    """Merge consecutive same-speaker turns separated by less than gap_s."""
    if not turns:
        return turns
    merged = [dict(turns[0])]
    for t in turns[1:]:
        last = merged[-1]
        if t['speaker'] == last['speaker'] and t['start'] - last['end'] < gap_s:
            last['end'] = max(last['end'], t['end'])
        else:
            merged.append(dict(t))
    return merged


def postprocess_turns(turns):
    turns = sorted(turns, key=lambda t: t['start'])
    turns = merge_turns(turns, MERGE_GAP_S)
    gap = MERGE_GAP_S
    while len(turns) > MAX_TURNS:
        gap *= 2
        turns = merge_turns(turns, gap)
    return turns


# ── Job processing ───────────────────────────────────────────────────────

def process_job(db, job_id, job):
    t0 = time.time()
    tmp_dir = tempfile.mkdtemp(prefix='notyx_diar_')
    keep_awake(True)
    try:
        src = download_audio(job['audioUrl'], tmp_dir)
        t_dl = time.time()

        wav_path = convert_to_wav(src, tmp_dir)
        t_conv = time.time()

        audio, duration = load_waveform(wav_path)
        output = get_pipeline()(audio)  # num_speakers unset = unknown-N auto
        turns = postprocess_turns(extract_turns(output))
        t_diar = time.time()

        speaker_count = len({t['speaker'] for t in turns})
        db.collection('diarizationJobs').document(job_id).update({
            'status': 'succeeded',
            'turns': turns,
            'speakerCount': speaker_count,
            'finishedAt': firestore.SERVER_TIMESTAMP,
        })

        rtf = (t_diar - t_conv) / duration if duration else 0.0
        print('[worker] {} OK dur={:.1f}s download={:.1f}s convert={:.1f}s diarize={:.1f}s rtf={:.2f} speakers={} turns={}'.format(
            job_id, duration, t_dl - t0, t_conv - t_dl, t_diar - t_conv, rtf, speaker_count, len(turns)))
    except Exception as e:
        print('[worker] {} FAILED: {}'.format(job_id, e))
        traceback.print_exc()
        try:
            db.collection('diarizationJobs').document(job_id).update({
                'status': 'failed',
                'error': str(e)[:500],
            })
        except Exception as e2:
            print('[worker] {} could not write failure status: {}'.format(job_id, e2))
    finally:
        keep_awake(False)
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    db = init_firebase()
    print('[worker] started, polling diarizationJobs every {}s'.format(POLL_SECONDS))
    while True:
        try:
            claimed = claim_job(db)
        except Exception as e:
            print('[worker] claim_job failed:', e)
            traceback.print_exc()
            claimed = None
        if claimed:
            process_job(db, *claimed)
            continue  # check for more queued work immediately
        time.sleep(POLL_SECONDS)


def _selftest():
    assert merge_turns([], 0.5) == []
    turns = [
        {'start': 0.0, 'end': 1.0, 'speaker': 'A'},
        {'start': 1.2, 'end': 2.0, 'speaker': 'A'},   # 0.2s gap < 0.5 -> merges into the A run
        {'start': 2.5, 'end': 3.0, 'speaker': 'B'},   # different speaker -> stays separate
    ]
    merged = merge_turns(turns, 0.5)
    assert merged == [
        {'start': 0.0, 'end': 2.0, 'speaker': 'A'},
        {'start': 2.5, 'end': 3.0, 'speaker': 'B'},
    ], merged

    # 6000 same-speaker turns 1.0s apart (0.9s gaps) — the starting 0.5s
    # merge threshold won't touch them, so postprocess_turns must widen the
    # gap and re-merge until the list is back under MAX_TURNS.
    many = [{'start': float(i), 'end': float(i) + 0.1, 'speaker': 'A'} for i in range(6000)]
    out = postprocess_turns(many)
    assert len(out) <= MAX_TURNS, len(out)
    print('[worker] selftest OK')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'selftest':
        _selftest()
    else:
        main()
