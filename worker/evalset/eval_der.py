"""Notyx U7b — DER evaluation of pyannote community-1 against the synthetic
Korean eval set built by build_evalset.py.

Reuses diarize_worker.py's HF_TOKEN loading, pipeline loader, and in-memory
waveform loader (torchcodec is broken on this machine — NEVER pipeline(path),
see diarize_worker.load_waveform) instead of reimplementing them.

CLI: eval_der.py conv1        (one conversation)
     eval_der.py all          (all convN.json found in this dir)
     eval_der.py selftest     (metric wiring check, no model/audio)
"""
import os
import sys
import json
import glob

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER_DIR = os.path.dirname(HERE)
sys.path.insert(0, WORKER_DIR)
import diarize_worker as dw  # noqa: E402  (path insert must precede this)

from pyannote.core import Annotation, Segment  # noqa: E402
from pyannote.metrics.diarization import DiarizationErrorRate  # noqa: E402


def load_reference(conv_name):
    with open(os.path.join(HERE, f'{conv_name}.json'), encoding='utf-8') as f:
        data = json.load(f)
    ref = Annotation(uri=conv_name)
    for t in data['turns']:
        ref[Segment(t['start'], t['end'])] = t['speaker']
    return ref


def run_conv(conv_name):
    wav_path = os.path.join(HERE, f'{conv_name}.wav')
    audio, duration = dw.load_waveform(wav_path)
    output = dw.get_pipeline()(audio)

    hyp = Annotation(uri=conv_name)
    for t in dw.extract_turns(output):
        hyp[Segment(t['start'], t['end'])] = t['speaker']

    ref = load_reference(conv_name)
    metric = DiarizationErrorRate()
    detail = metric(ref, hyp, detailed=True)
    return detail, duration


def _fmt(name, detail, duration):
    total = detail['total'] or 1e-9
    return ('{}: DER={:.3f} FA={:.3f} miss={:.3f} conf={:.3f} dur={:.1f}s'.format(
        name, detail['diarization error rate'],
        detail['false alarm'] / total, detail['missed detection'] / total,
        detail['confusion'] / total, duration))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if arg == 'selftest':
        return _selftest()

    if arg == 'all':
        names = sorted(
            os.path.splitext(os.path.basename(p))[0]
            for p in glob.glob(os.path.join(HERE, 'conv*.json'))
        )
    else:
        names = [arg]

    ders = []
    for name in names:
        detail, duration = run_conv(name)
        print(_fmt(name, detail, duration))
        ders.append(detail['diarization error rate'])
    if len(ders) > 1:
        print('mean DER={:.3f}'.format(sum(ders) / len(ders)))


def _selftest():
    """Metric + reference-loading wiring check — no model load, no audio."""
    ref = Annotation(uri='t')
    ref[Segment(0, 1)] = 'A'
    ref[Segment(1, 2)] = 'B'
    hyp = Annotation(uri='t')
    hyp[Segment(0, 1)] = 'x'
    hyp[Segment(1, 1.9)] = 'y'
    detail = DiarizationErrorRate()(ref, hyp, detailed=True)
    assert abs(detail['diarization error rate'] - 0.05) < 1e-6, detail
    line = _fmt('t', detail, 2.0)
    assert 'DER=0.050' in line, line
    print('[eval_der] selftest OK')


if __name__ == '__main__':
    main()
