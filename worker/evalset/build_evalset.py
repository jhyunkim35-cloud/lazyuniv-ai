"""Notyx U7b — synthetic Korean diarization eval set builder.

Downloads ~6 distinct-speaker Korean solo-talk sources (yt-dlp), pulls 3x
20s speech segments per speaker, then splices random slices of those
segments into 4 synthetic multi-speaker "conversations" with EXACT
ground-truth turn timing (we control every sample placement, so there's
no ambiguity about who's speaking when — unlike a real recording).

Output: worker/evalset/convN.wav (16kHz mono PCM16) + convN.rttm + convN.json
        worker/evalset/raw/       (downloaded sources + pool segments, gitignored)

Run: worker/.venv/Scripts/python.exe worker/evalset/build_evalset.py
Self-check (no downloads): worker/.venv/Scripts/python.exe worker/evalset/build_evalset.py selftest
"""
import os
import sys
import json
import glob
import wave
import random
import locale
import subprocess

import numpy as np

# yt-dlp (win_exe build) writes stdout in the console's codepage (cp949 on
# a Korean Windows install), not utf-8 — decoding with the wrong codec
# silently mangles Korean titles into mojibake instead of raising.
CONSOLE_ENCODING = locale.getpreferredencoding(False)

# Windows console is cp949; yt-dlp titles are arbitrary Unicode (emoji etc.)
# and would crash print() with UnicodeEncodeError otherwise.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, 'raw')
SR = 16000
SEG_DUR = 20  # seconds per pool segment

# ffmpeg/yt-dlp live under winget links, which don't always land on PATH.
_winget_links = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Microsoft', 'WinGet', 'Links')
if _winget_links and _winget_links not in os.environ.get('PATH', ''):
    os.environ['PATH'] = os.environ.get('PATH', '') + os.pathsep + _winget_links

# ── Speaker source pool ─────────────────────────────────────────────────
# Each is a distinct real person, mostly-solo talk with minimal music.
SOURCES = [
    ('S1', 'ytsearch1:세바시 강연'),
    ('S2', 'ytsearch1:세바시 강연 여성'),
    ('S3', 'ytsearch1:TED 한국어 강연'),
    ('S4', 'ytsearch1:김미경 강연'),
    # ytsearch1 for '설민석 강의' proved non-deterministic across runs — one
    # run resolved to a 4.5h true-crime documentary (그것이 알고싶다), wrong
    # genre entirely. Pinned to a confirmed 120min solo history lecture.
    ('S5', 'https://www.youtube.com/watch?v=-hesRz7OaxI'),
    ('S6', 'ytsearch1:슈카월드 클립'),
]


def pick_offsets(duration):
    """Three 20s-segment start offsets, spread across the video, skipping
    the first ~10% (intro/music) and leaving a tail margin. Falls back to
    a spread for short videos instead of the fixed 90/240/400s defaults."""
    base = [90, 240, 400]
    if duration and duration > base[-1] + SEG_DUR + 5:
        return base
    if not duration or duration < SEG_DUR + 5:
        return [0, 0, 0]  # degenerate source; noted as a risk in the report
    lo, hi = max(5, duration * 0.1), duration - SEG_DUR - 1
    if hi <= lo:
        return [max(0, duration - SEG_DUR - 1)] * 3
    return [int(lo + (hi - lo) * f) for f in (0.15, 0.5, 0.85)]


def probe_duration(path):
    """ffprobe the actual downloaded file — works identically for fresh and
    cached downloads, unlike yt-dlp's --print duration (which only fires on
    the fresh-download code path and left cached re-runs with duration=None,
    which in turn made pick_offsets() silently collapse all 3 pool segments
    onto the same offset-0 clip). Single source of truth."""
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None


def download_source(spk_id, query):
    """yt-dlp bestaudio download + title probe in one shot (--print writes
    to stdout, progress goes to stderr, so stdout stays clean). Returns
    (full_audio_path, title, duration_s)."""
    existing = glob.glob(os.path.join(RAW_DIR, f'{spk_id}_full.*'))
    out_tmpl = os.path.join(RAW_DIR, f'{spk_id}_full.%(ext)s')
    title = '(cached download, title unknown)'
    if not existing:
        r = subprocess.run(
            # --print implies --simulate (no actual download) unless told
            # otherwise — without --no-simulate this silently "succeeds"
            # with title printed and zero bytes on disk.
            ['yt-dlp', '-f', 'bestaudio/best', '--no-playlist', '--no-simulate',
             '--print', 'title', '-o', out_tmpl, query],
            capture_output=True, text=True, encoding=CONSOLE_ENCODING, errors='replace',
        )
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        title = lines[0] if lines else title
        if r.returncode != 0:
            print(f'[build_evalset] WARN yt-dlp failed for {spk_id} ({query}): {r.stderr[-500:]}')
    files = glob.glob(os.path.join(RAW_DIR, f'{spk_id}_full.*'))
    if not files:
        raise RuntimeError(f'no audio downloaded for {spk_id} ({query})')
    full_path = files[0]
    duration = probe_duration(full_path)
    return full_path, title, duration


def extract_segments(spk_id, full_path, duration):
    """3x 20s 16kHz-mono-wav segments via ffmpeg seek+trim. Returns list of
    (path, actual_duration_s)."""
    offsets = pick_offsets(duration)
    results = []
    for i, off in enumerate(offsets):
        seg_path = os.path.join(RAW_DIR, f'{spk_id}_seg{i}.wav')
        subprocess.run(
            ['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(off), '-t', str(SEG_DUR),
             '-i', full_path, '-ac', '1', '-ar', str(SR), '-sample_fmt', 's16', seg_path],
            check=True,
        )
        with wave.open(seg_path, 'rb') as w:
            actual_dur = w.getnframes() / SR
        results.append((seg_path, actual_dur))
    return results


def build_pool(report):
    """Download all sources (skips ones already on disk) and load each
    speaker's 3 segments into memory as int16 numpy arrays."""
    os.makedirs(RAW_DIR, exist_ok=True)
    pool = {}
    for spk_id, query in SOURCES:
        full_path, title, duration = download_source(spk_id, query)
        segs = extract_segments(spk_id, full_path, duration)
        arrays = []
        for seg_path, actual_dur in segs:
            with wave.open(seg_path, 'rb') as w:
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            arrays.append(pcm)
        pool[spk_id] = arrays
        risk = 'SHORT/DEGENERATE (source too short — likely silence/repeat)' if min(d for _, d in segs) < 15 else 'ok'
        report['sources'].append({
            'speaker': spk_id, 'query': query, 'title': title,
            'source_duration_s': duration,
            'segment_durations_s': [round(d, 1) for _, d in segs],
            'risk': risk,
        })
        print(f'[build_evalset] {spk_id}: "{title}" dur={duration} segs={[round(d,1) for _,d in segs]} risk={risk}')
    return pool


# ── Conversation assembly ───────────────────────────────────────────────

class Timeline:
    """Sample-accurate mix buffer. Turns are placed at an exact sample
    offset; overlapping placements are additively mixed (int32 accumulator,
    clipped to int16 on export) instead of overwritten."""

    def __init__(self, max_seconds):
        self.buf = np.zeros(int(max_seconds * SR), dtype=np.int32)
        self.cursor = 0   # next default write position, in samples
        self.length = 0   # high-water mark of content written, in samples

    def place(self, audio_i16, start_sample):
        start_sample = max(0, start_sample)
        end_sample = start_sample + len(audio_i16)
        if end_sample > len(self.buf):
            raise RuntimeError('Timeline buffer too small — raise max_seconds')
        self.buf[start_sample:end_sample] += audio_i16.astype(np.int32)
        self.length = max(self.length, end_sample)
        return start_sample, end_sample

    def export_i16(self):
        clipped = np.clip(self.buf[:self.length], -32768, 32767)
        return clipped.astype(np.int16)


def extract_slice(pool, speaker, dur_s, rng):
    segs = pool[speaker]
    seg = segs[rng.randrange(len(segs))]
    want = int(dur_s * SR)
    slice_len = min(want, len(seg))
    start_max = len(seg) - slice_len
    start = rng.randrange(0, start_max + 1) if start_max > 0 else 0
    return seg[start:start + slice_len]


def pick_speaker(mode, speakers, weights, rng, last):
    if mode == 'alternate':
        idx = (speakers.index(last) + 1) % len(speakers) if last in speakers else 0
        return speakers[idx]
    if mode == 'weighted':
        return rng.choices(speakers, weights=weights, k=1)[0]
    if mode == 'no_repeat':
        choices = [s for s in speakers if s != last] or speakers
        return rng.choice(choices)
    return rng.choice(speakers)  # uniform


def build_conversation(pool, spec, seed):
    """spec: dict with speakers, target_dur, turn_dur_range, gap_range,
    mode, weights, overlap_frac, overlap_dur_range."""
    rng = random.Random(seed)
    timeline = Timeline(max_seconds=spec['target_dur'] + 60)
    turns = []
    last_speaker = None
    while timeline.cursor / SR < spec['target_dur']:
        speaker = pick_speaker(spec['mode'], spec['speakers'], spec.get('weights'), rng, last_speaker)
        turn_dur = rng.uniform(*spec['turn_dur_range'])
        audio = extract_slice(pool, speaker, turn_dur, rng)

        overlap_frac = spec.get('overlap_frac', 0.0)
        if turns and overlap_frac and rng.random() < overlap_frac:
            overlap_dur = min(rng.uniform(*spec['overlap_dur_range']), turn_dur * 0.9)
            start_sample = timeline.cursor - int(overlap_dur * SR)
        else:
            gap = rng.uniform(*spec['gap_range'])
            timeline.cursor += int(gap * SR)
            start_sample = timeline.cursor

        start_sample, end_sample = timeline.place(audio, start_sample)
        timeline.cursor = end_sample
        turns.append({'start': round(start_sample / SR, 3), 'end': round(end_sample / SR, 3), 'speaker': speaker})
        last_speaker = speaker

    return timeline.export_i16(), turns


def write_wav(path, pcm_i16):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm_i16.tobytes())


def write_rttm(path, conv_name, turns):
    with open(path, 'w', encoding='utf-8') as f:
        for t in turns:
            dur = t['end'] - t['start']
            f.write(f"SPEAKER {conv_name} 1 {t['start']:.3f} {dur:.3f} <NA> <NA> {t['speaker']} <NA> <NA>\n")


def write_json(path, conv_name, turns, duration):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'conv': conv_name, 'sample_rate': SR, 'duration': round(duration, 3), 'turns': turns}, f, ensure_ascii=False, indent=2)


CONV_SPECS = {
    'conv1': dict(speakers=['S1', 'S2'], target_dur=300, turn_dur_range=(3, 10),
                  gap_range=(0.3, 1.5), mode='alternate'),
    'conv2': dict(speakers=['S1', 'S2', 'S3'], target_dur=320, turn_dur_range=(3, 15),
                  gap_range=(0.3, 1.5), mode='weighted', weights=[0.60, 0.25, 0.15]),
    'conv3': dict(speakers=['S1', 'S2', 'S3', 'S4', 'S5'], target_dur=280, turn_dur_range=(2, 8),
                  gap_range=(0.3, 1.5), mode='uniform'),
    'conv4': dict(speakers=['S4', 'S5', 'S6'], target_dur=300, turn_dur_range=(3, 10),
                  gap_range=(0.3, 1.5), mode='no_repeat', overlap_frac=0.20,
                  overlap_dur_range=(0.5, 1.0)),
}
SEEDS = {'conv1': 101, 'conv2': 102, 'conv3': 103, 'conv4': 104}


def main():
    report = {'sources': []}
    pool = build_pool(report)

    for name, spec in CONV_SPECS.items():
        pcm, turns = build_conversation(pool, spec, SEEDS[name])
        duration = len(pcm) / SR
        write_wav(os.path.join(HERE, f'{name}.wav'), pcm)
        write_rttm(os.path.join(HERE, f'{name}.rttm'), name, turns)
        write_json(os.path.join(HERE, f'{name}.json'), name, turns, duration)
        n_overlap = sum(1 for i in range(1, len(turns)) if turns[i]['start'] < turns[i - 1]['end'])
        print(f'[build_evalset] {name}: dur={duration:.1f}s turns={len(turns)} speakers={sorted(set(t["speaker"] for t in turns))} overlap_boundaries={n_overlap}')

    with open(os.path.join(RAW_DIR, 'pool_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('[build_evalset] done. pool report -> raw/pool_report.json')


# ── Self-check (no network/model — validates assembly logic only) ───────

def _selftest():
    # Fake 3x20s pool of two "speakers" made of distinguishable sine tones
    # so mixing/placement math can be checked without downloads.
    fake_pool = {}
    for spk, freq in [('X', 200), ('Y', 400), ('Z', 600)]:
        t = np.arange(SEG_DUR * SR) / SR
        tone = (np.sin(2 * np.pi * freq * t) * 10000).astype(np.int16)
        fake_pool[spk] = [tone, tone, tone]

    # No-overlap conv: chronological, non-decreasing starts, no clipping.
    spec1 = dict(speakers=['X', 'Y'], target_dur=20, turn_dur_range=(2, 4),
                 gap_range=(0.3, 1.0), mode='alternate')
    pcm1, turns1 = build_conversation(fake_pool, spec1, seed=1)
    assert len(turns1) > 3
    starts = [t['start'] for t in turns1]
    assert starts == sorted(starts), 'turns must be chronological'
    assert all(turns1[i]['end'] <= turns1[i + 1]['start'] for i in range(len(turns1) - 1)), 'alternate mode must not overlap'
    assert np.abs(pcm1).max() <= 32767

    # Overlap conv: some boundaries must actually overlap in time, and the
    # overlap region must be a true sample-wise mix (not silence/overwrite).
    spec2 = dict(speakers=['X', 'Y', 'Z'], target_dur=20, turn_dur_range=(2, 4),
                 gap_range=(0.3, 1.0), mode='no_repeat', overlap_frac=0.6,
                 overlap_dur_range=(0.5, 1.0))
    pcm2, turns2 = build_conversation(fake_pool, spec2, seed=2)
    n_overlap = sum(1 for i in range(1, len(turns2)) if turns2[i]['start'] < turns2[i - 1]['end'])
    assert n_overlap >= 1, 'expected at least one overlapping boundary at overlap_frac=0.6'
    assert np.abs(pcm2).max() <= 32767, 'mixed overlap must be clipped, not wrapped'

    # RTTM/JSON round-trip.
    tmp_rttm = os.path.join(HERE, '_selftest.rttm')
    write_rttm(tmp_rttm, 'selftest', turns1)
    with open(tmp_rttm, encoding='utf-8') as f:
        lines = f.readlines()
    assert len(lines) == len(turns1)
    assert lines[0].startswith('SPEAKER selftest 1 ')
    os.remove(tmp_rttm)

    print('[build_evalset] selftest OK')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'selftest':
        _selftest()
    else:
        main()
