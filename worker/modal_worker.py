"""Notyx U7c — Modal GPU diarization worker (cloud twin of diarize_worker.py).

Same Firestore job-queue contract as the local worker: a cron function polls
`diarizationJobs` every 5 minutes and spawns one T4 GPU container per pending
job (up to Modal Starter's 10 concurrent GPUs). Laptop off, queue still
drains; both workers can run side by side (transactional claim wins races).

Cost: T4 $0.59/hr, 60-min lecture ~= 2-3 min => ~$0.03/lecture, inside the
$30/month free credits (~800-1,000 lectures/month at $0).

Deploy:  modal deploy worker/modal_worker.py
Secrets: modal secret create notyx-diarization \
           HF_TOKEN=hf_... FIREBASE_SERVICE_ACCOUNT_JSON="$(cat worker/serviceAccount.json)"
"""
import json
import os
import time

import modal

app = modal.App('notyx-diarization')

# ponytail: model weights cached in a Volume so warm-ish starts skip the
# HF download; container cold boot + load is ~30-60s on top of ~2-3min work.
hf_cache = modal.Volume.from_name('notyx-hf-cache', create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version='3.12')
    .apt_install('ffmpeg')
    .pip_install('pyannote.audio==4.0.7', 'firebase-admin', 'requests')
    # HF_HUB_DISABLE_PROGRESS_BARS: hf_hub's fancy download progress ('◇'
    # glyphs via rich) crashes with ascii-codec errors under Modal's stream
    # wrapper even with PYTHONUTF8 — kill the progress output entirely, we
    # don't watch it anyway. PYTHONIOENCODING as belt-and-suspenders.
    .env({'HF_HOME': '/hf-cache', 'PYTHONUTF8': '1',
          'PYTHONIOENCODING': 'utf-8',
          'HF_HUB_DISABLE_PROGRESS_BARS': '1'})
)

secret = modal.Secret.from_name('notyx-diarization')

MERGE_GAP_S = 0.5
MAX_TURNS = 5000
RECLAIM_HOURS = 3


def _db():
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        cred = credentials.Certificate(json.loads(os.environ['FIREBASE_SERVICE_ACCOUNT_JSON']))
        firebase_admin.initialize_app(cred)
    return firestore.client()


def _merge_turns(turns, gap_s):
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


def _postprocess(turns):
    turns = sorted(turns, key=lambda t: t['start'])
    turns = _merge_turns(turns, MERGE_GAP_S)
    gap = MERGE_GAP_S
    while len(turns) > MAX_TURNS:
        gap *= 2
        turns = _merge_turns(turns, gap)
    return turns


@app.function(image=image, gpu='T4', secrets=[secret],
              volumes={'/hf-cache': hf_cache}, timeout=1800)
def diarize_job(job_id: str):
    """Claim + process one job on GPU. Mirrors diarize_worker.process_job."""
    import subprocess
    import tempfile

    import requests
    from firebase_admin import firestore

    db = _db()
    ref = db.collection('diarizationJobs').document(job_id)

    # Transactional claim — safe against the laptop worker and other containers.
    @firestore.transactional
    def _claim(tx):
        snap = ref.get(transaction=tx)
        if not snap.exists:
            return None
        d = snap.to_dict()
        if d.get('status') == 'pending':
            pass  # claimable
        elif d.get('status') == 'running':
            started = d.get('startedAt')
            started_s = started.timestamp() if hasattr(started, 'timestamp') else 0
            if started_s > time.time() - RECLAIM_HOURS * 3600:
                return None  # someone else is actively on it
        else:
            return None  # terminal
        tx.update(ref, {'status': 'running', 'startedAt': firestore.SERVER_TIMESTAMP,
                        'workerKind': 'modal-t4'})
        return d

    job = _claim(db.transaction())
    if job is None:
        print(f'[modal] {job_id} not claimable, skipping')
        return

    t0 = time.time()
    tmp = tempfile.mkdtemp()
    try:
        src = os.path.join(tmp, 'in')
        with open(src, 'wb') as f:
            r = requests.get(job['audioUrl'], timeout=300)
            r.raise_for_status()
            f.write(r.content)

        wav = os.path.join(tmp, 'out.wav')
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src,
                        '-ac', '1', '-ar', '16000', wav], check=True)

        # Linux torchcodec works fine (unlike the Windows laptop) — but reuse
        # the same in-memory waveform path so both workers behave identically.
        import wave as wavmod

        import numpy as np
        import torch
        from pyannote.audio import Pipeline

        with wavmod.open(wav, 'rb') as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            duration = w.getnframes() / 16000.0
        waveform = torch.from_numpy(pcm.astype(np.float32) / 32768.0).unsqueeze(0)

        pipeline = Pipeline.from_pretrained('pyannote/speaker-diarization-community-1',
                                            token=os.environ['HF_TOKEN'])
        pipeline.to(torch.device('cuda'))
        output = pipeline({'waveform': waveform, 'sample_rate': 16000})
        hf_cache.commit()

        ann = getattr(output, 'exclusive_speaker_diarization', None)
        if ann is None:
            ann = output.speaker_diarization
        turns = _postprocess([
            {'start': round(seg.start, 3), 'end': round(seg.end, 3), 'speaker': str(label)}
            for seg, _, label in ann.itertracks(yield_label=True)
        ])

        ref.update({
            'status': 'succeeded',
            'turns': turns,
            'speakerCount': len({t['speaker'] for t in turns}),
            'finishedAt': firestore.SERVER_TIMESTAMP,
        })
        el = time.time() - t0
        print(f'[modal] {job_id} OK dur={duration:.0f}s wall={el:.0f}s '
              f'rtf={el / duration if duration else 0:.3f} turns={len(turns)}')
    except Exception as e:
        import traceback
        print(f'[modal] {job_id} FAILED: {e}')
        traceback.print_exc()
        try:
            ref.update({'status': 'failed', 'error': str(e)[:500]})
        except Exception as e2:
            print(f'[modal] {job_id} could not write failure: {e2}')


@app.function(image=image, secrets=[secret], schedule=modal.Cron('*/5 * * * *'))
def poll_queue():
    """CPU cron: every 5 min, fan pending jobs out to GPU containers."""
    db = _db()
    pending = list(db.collection('diarizationJobs')
                   .where('status', '==', 'pending').limit(10).stream())
    if not pending:
        return
    print(f'[modal] spawning {len(pending)} job(s)')
    for doc in pending:
        diarize_job.spawn(doc.id)
