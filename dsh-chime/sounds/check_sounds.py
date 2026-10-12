"""铃声自检：读回 WAV，打印包络音节（音符起落）与主要音高，确认乐句真的成型。

用法：python check_sounds.py [目录]
"""
import os
import sys
import wave
import numpy as np

SR = 22050


def load(path):
    with wave.open(path, 'rb') as w:
        assert w.getframerate() == SR, f'{path}: 采样率 {w.getframerate()} != {SR}'
        assert w.getnchannels() == 1, f'{path}: 不是单声道'
        data = np.frombuffer(w.readframes(w.getnframes()), '<i2').astype(np.float64) / 32768.0
    return data


def envelope_ticks(sig, hop=512, rows=8):
    """把包络画成竖条纹，按 20 段/秒聚合，肉眼能看出音节数。"""
    frames = len(sig) // hop
    env = np.array([np.max(np.abs(sig[i * hop:(i + 1) * hop])) for i in range(frames)])
    per_sec = SR / hop
    step = max(1, int(round(per_sec / 20)))
    seg = np.array([env[i:i + step].max() for i in range(0, frames, step)])
    if seg.max() > 0:
        seg = seg / seg.max()
    levels = ' .:-=+*#%@'
    bars = [levels[min(len(levels) - 1, int(v * (len(levels) - 1)))] for v in seg]
    out = []
    for r in range(rows, 0, -1):
        thr = r / rows
        out.append(''.join('#' if seg[i] >= thr else ' ' for i in range(len(seg))))
    out.append(''.join(bars))
    return '\n'.join(out), seg


def onsets(sig, hop=256, thresh=0.18):
    """上升沿检测：包络从低于阈值跳到高于阈值即一次击打。"""
    frames = len(sig) // hop
    env = np.array([np.max(np.abs(sig[i * hop:(i + 1) * hop])) for i in range(frames)])
    if env.max() > 0:
        env = env / env.max()
    hits, prev = [], 0.0
    for i, v in enumerate(env):
        if v >= thresh and prev < thresh:
            hits.append(i * hop / SR)
        prev = v
    return hits


def dominant_freqs(sig, top=4):
    """整段 FFT 的前几个峰（用于确认音高符合设计）。"""
    win = sig * np.hanning(len(sig))
    spec = np.abs(np.fft.rfft(win))
    freqs = np.fft.rfftfreq(len(sig), 1 / SR)
    order = np.argsort(spec)[::-1]
    picked = []
    for idx in order:
        f = freqs[idx]
        if f < 120:
            continue
        if any(abs(f - p) < 25 for p in picked):
            continue
        picked.append(f)
        if len(picked) >= top:
            break
    return sorted(picked)


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    for name in ('complete', 'assist', 'alert', 'blip'):
        path = os.path.join(d, name + '.wav')
        if not os.path.exists(path):
            print(f'!! 缺少 {path}')
            continue
        sig = load(path)
        art, seg = envelope_ticks(sig)
        hits = onsets(sig)
        freqs = dominant_freqs(sig)
        print(f'=== {name}.wav  {len(sig) / SR:.2f}s ===')
        print(art)
        print('  击打时刻(s): ' + ', '.join(f'{h:.2f}' for h in hits))
        print('  主频(Hz):    ' + ', '.join(f'{f:.0f}' for f in freqs))
        print(f'  RMS={np.sqrt(np.mean(sig ** 2)):.4f}  peak={np.max(np.abs(sig)):.3f}  静音占比={float(np.mean(np.abs(sig) < 1e-4)):.1%}')
        print()


if __name__ == '__main__':
    main()
