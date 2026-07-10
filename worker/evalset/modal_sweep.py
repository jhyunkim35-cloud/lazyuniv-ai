"""U7d — hyperparameter sweep for community-1 on the synthetic Korean dev set.

Runs on Modal T4s, one container per conversation (4 parallel); each container
loads the model once and evaluates every config in GRID on its conv. Default
config is in the grid, so the GPU baseline comes out of the same run.

Run:  modal run worker/evalset/modal_sweep.py
Cost: ~45 configs x 4 convs x ~15s inference ~= $0.5-1.5 of free credits.
"""
import itertools
import json
import os

import modal

app = modal.App('notyx-diar-sweep')

hf_cache = modal.Volume.from_name('notyx-hf-cache', create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version='3.12')
    .pip_install('pyannote.audio==4.0.7', 'pyannote.metrics')
    .env({'HF_HOME': '/hf-cache', 'PYTHONUTF8': '1',
          'HF_HUB_DISABLE_PROGRESS_BARS': '1'})
    .add_local_dir(os.path.dirname(os.path.abspath(__file__)), '/evalset')
)

secret = modal.Secret.from_name('notyx-diarization')

# 45-config grid around the shipped defaults (threshold .6, Fa .07, Fb .8,
# min_duration_off 0.0). threshold is the over/under-split knob and gets the
# finest sampling.
GRID = [
    {'segmentation': {'min_duration_off': mdo},
     'clustering': {'threshold': th, 'Fa': fa, 'Fb': fb}}
    for th, mdo, (fa, fb) in itertools.product(
        [0.50, 0.55, 0.60, 0.65, 0.70],
        [0.0, 0.1, 0.2],
        [(0.04, 0.8), (0.07, 0.8), (0.10, 1.1)],
    )
]


@app.function(image=image, gpu='T4', secrets=[secret],
              volumes={'/hf-cache': hf_cache}, timeout=3600)
def sweep_conv(conv: str):
    import wave

    import numpy as np
    import torch
    from pyannote.audio import Pipeline
    from pyannote.core import Annotation, Segment
    from pyannote.metrics.diarization import DiarizationErrorRate

    with wave.open(f'/evalset/{conv}.wav', 'rb') as w:
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    audio = {'waveform': torch.from_numpy(pcm.astype(np.float32) / 32768.0).unsqueeze(0),
             'sample_rate': 16000}

    reference = Annotation()
    for t in json.load(open(f'/evalset/{conv}.json'))['turns']:
        reference[Segment(t['start'], t['end'])] = t['speaker']

    pipeline = Pipeline.from_pretrained('pyannote/speaker-diarization-community-1',
                                        token=os.environ['HF_TOKEN'])
    pipeline.to(torch.device('cuda'))
    hf_cache.commit()

    results = []
    for i, params in enumerate(GRID):
        pipeline.instantiate(params)
        output = pipeline(audio)
        ann = getattr(output, 'exclusive_speaker_diarization', None)
        if ann is None:
            ann = output.speaker_diarization
        hyp = Annotation()
        for seg, _, label in ann.itertracks(yield_label=True):
            hyp[seg] = label
        metric = DiarizationErrorRate()
        der = metric(reference, hyp)
        results.append({'conv': conv, 'params': params, 'der': round(der, 4),
                        'speakers': len(hyp.labels())})
        print(f'[{conv}] {i + 1}/{len(GRID)} der={der:.4f} spk={len(hyp.labels())} {params}')
    return results


@app.function(image=image, gpu='T4', secrets=[secret],
              volumes={'/hf-cache': hf_cache}, timeout=900)
def check_real(params_json: str):
    """Run a candidate config on the two REAL clips (overfit guard):
    multi_discussion (매불쇼, truth 3 speakers), single_lecture (truth 1)."""
    import wave

    import numpy as np
    import torch
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained('pyannote/speaker-diarization-community-1',
                                        token=os.environ['HF_TOKEN'])
    pipeline.to(torch.device('cuda'))
    params = json.loads(params_json)
    if params:
        pipeline.instantiate(params)

    out = {}
    for clip, expect in (('multi_discussion', 3), ('single_lecture', 1)):
        with wave.open(f'/evalset/{clip}.wav', 'rb') as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        audio = {'waveform': torch.from_numpy(pcm.astype(np.float32) / 32768.0).unsqueeze(0),
                 'sample_rate': 16000}
        res = pipeline(audio)
        ann = getattr(res, 'exclusive_speaker_diarization', None) or res.speaker_diarization
        n = len({l for _, _, l in ann.itertracks(yield_label=True)})
        out[clip] = {'speakers': n, 'expect': expect, 'pass': n == expect}
        print(f'[check_real] {clip}: {n} speakers (expect {expect})',
              'PASS' if n == expect else 'FAIL')
    return out


@app.local_entrypoint()
def check(params: str = ''):
    """modal run worker/evalset/modal_sweep.py::check --params '{...}'"""
    result = check_real.remote(params or '{}')
    print(json.dumps(result))


@app.local_entrypoint()
def main():
    convs = ['conv1', 'conv2', 'conv3', 'conv4']
    all_results = []
    for batch in sweep_conv.map(convs):
        all_results.extend(batch)

    # Aggregate: mean DER per config across convs.
    by_cfg = {}
    for r in all_results:
        key = json.dumps(r['params'], sort_keys=True)
        by_cfg.setdefault(key, []).append(r['der'])
    ranked = sorted(((sum(v) / len(v), k) for k, v in by_cfg.items()))

    default_key = json.dumps(
        {'segmentation': {'min_duration_off': 0.0},
         'clustering': {'threshold': 0.60, 'Fa': 0.07, 'Fb': 0.8}}, sort_keys=True)
    default_der = sum(by_cfg[default_key]) / len(by_cfg[default_key])

    print('\n=== TOP 5 configs (mean DER over 4 convs) ===')
    for der, key in ranked[:5]:
        print(f'{der:.4f}  {key}')
    print(f'\ndefault config mean DER: {default_der:.4f}')
    print(f'best improvement: {default_der - ranked[0][0]:+.4f}')

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sweep_results.json')
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=1)
    print(f'full results -> {out}')
