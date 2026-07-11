"""U7e — evaluate two candidate upgrades against the U7d-tuned baseline:

  1. loudnorm: ffmpeg `-af loudnorm` preprocessing before diarization
  2. hint:     num_speakers=<truth> passed to the pipeline (speaker-count hint UI)

Same rig as modal_sweep.py: synthetic dev set (conv1-4, DER vs ground truth)
plus the two REAL clips as the overfit guard (speaker-count check only).

Run:  modal run worker/evalset/eval_u7e.py
Adoption rules (U7d lesson — synthetic wins must hold on real audio):
  - loudnorm: adopt only if mean DER improves AND real clip counts hold.
  - hint:     ship only if DER with a correct hint >= parity on every conv.
"""
import json
import os

import modal

app = modal.App('notyx-u7e-eval')

hf_cache = modal.Volume.from_name('notyx-hf-cache', create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version='3.12')
    .apt_install('ffmpeg')
    .pip_install('pyannote.audio==4.0.7', 'pyannote.metrics')
    .env({'HF_HOME': '/hf-cache', 'PYTHONUTF8': '1',
          'HF_HUB_DISABLE_PROGRESS_BARS': '1'})
    .add_local_dir(os.path.dirname(os.path.abspath(__file__)), '/evalset')
)

secret = modal.Secret.from_name('notyx-diarization')

# Shipped U7d params — keep in sync with worker/diarize_worker.py TUNED_PARAMS.
TUNED_PARAMS = {
    'segmentation': {'min_duration_off': 0.0},
    'clustering': {'threshold': 0.65, 'Fa': 0.07, 'Fb': 0.8},
}

# loudnorm resamples internally — force the output back to 16k mono PCM16.
LOUDNORM_ARGS = ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
                 '-ar', '16000', '-ac', '1', '-sample_fmt', 's16']


@app.function(image=image, gpu='T4', secrets=[secret],
              volumes={'/hf-cache': hf_cache}, timeout=1800)
def eval_clip(clip: str):
    """Run base / loudnorm / hint variants on one clip.

    Synthetic convs (convN) report DER + speaker count; real clips report
    speaker count only (no ground-truth RTTM).
    """
    import subprocess
    import wave

    import numpy as np
    import torch
    from pyannote.audio import Pipeline
    from pyannote.core import Annotation, Segment

    def load_audio(path):
        with wave.open(path, 'rb') as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        return {'waveform': torch.from_numpy(pcm.astype(np.float32) / 32768.0).unsqueeze(0),
                'sample_rate': 16000}

    src = f'/evalset/{clip}.wav'
    norm = f'/tmp/{clip}_norm.wav'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, *LOUDNORM_ARGS, norm],
                   check=True)

    # Quiet-recording scenario (the case loudnorm exists for): kill the level
    # by -20dB, then see whether loudnorm recovers what the quiet input loses.
    quiet = f'/tmp/{clip}_quiet.wav'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src,
                    '-af', 'volume=0.1', '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
                    quiet], check=True)
    quiet_norm = f'/tmp/{clip}_quiet_norm.wav'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', quiet, *LOUDNORM_ARGS, quiet_norm],
                   check=True)

    reference, truth_n = None, None
    meta_path = f'/evalset/{clip}.json'
    if os.path.exists(meta_path):
        reference = Annotation()
        speakers = set()
        for t in json.load(open(meta_path))['turns']:
            reference[Segment(t['start'], t['end'])] = t['speaker']
            speakers.add(t['speaker'])
        truth_n = len(speakers)
    else:
        truth_n = {'multi_discussion': 3, 'single_lecture': 1}[clip]

    pipeline = Pipeline.from_pretrained('pyannote/speaker-diarization-community-1',
                                        token=os.environ['HF_TOKEN'])
    pipeline.to(torch.device('cuda'))
    pipeline.instantiate(TUNED_PARAMS)
    hf_cache.commit()

    def run(audio, **kwargs):
        out = pipeline(audio, **kwargs)
        ann = getattr(out, 'exclusive_speaker_diarization', None)
        if ann is None:
            ann = out.speaker_diarization
        hyp = Annotation()
        for seg, _, label in ann.itertracks(yield_label=True):
            hyp[seg] = label
        der = None
        if reference is not None:
            from pyannote.metrics.diarization import DiarizationErrorRate
            der = round(DiarizationErrorRate()(reference, hyp), 4)
        return {'der': der, 'speakers': len(hyp.labels())}

    base_audio, norm_audio = load_audio(src), load_audio(norm)
    results = {
        'clip': clip, 'truth_speakers': truth_n,
        'base': run(base_audio),
        'loudnorm': run(norm_audio),
        'hint': run(base_audio, num_speakers=truth_n),
        'quiet': run(load_audio(quiet)),
        'quiet_loudnorm': run(load_audio(quiet_norm)),
    }
    print(json.dumps(results))
    return results


@app.local_entrypoint()
def main():
    clips = ['conv1', 'conv2', 'conv3', 'conv4', 'multi_discussion', 'single_lecture']
    all_results = list(eval_clip.map(clips))

    variants = ('base', 'loudnorm', 'hint', 'quiet', 'quiet_loudnorm')
    print('\n=== U7e eval ===')
    print(f'{"clip":18} {"truth":5} | ' + ' | '.join(f'{v:14}' for v in variants))
    for r in all_results:
        def fmt(v):
            d = f'{v["der"]:.4f}' if v['der'] is not None else '  -  '
            return f'{d}/{v["speakers"]}'
        print(f'{r["clip"]:18} {r["truth_speakers"]:5} | '
              + ' | '.join(f'{fmt(r[v]):14}' for v in variants))

    convs = [r for r in all_results if r['base']['der'] is not None]
    for variant in variants:
        mean = sum(r[variant]['der'] for r in convs) / len(convs)
        print(f'mean DER ({variant}): {mean:.4f}')

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'u7e_results.json')
    with open(out, 'w') as f:
        json.dump(all_results, f, indent=1)
    print(f'full results -> {out}')
