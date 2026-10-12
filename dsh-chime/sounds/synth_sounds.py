"""铃声合成器 — 为 dsh-chime 插件生成 WAV 音频资源。

不依赖音频库：纯 numpy 加法合成 + 包络整形，输出 22050 Hz 单声道 16-bit PCM。
三档音色刻意做出「缓/急/警」的听感差异，靠的是起音时间、音符间距与重复次数，
而不是单纯改音量——音量一变小，用户在外屋干活时就真听不见了。

用法：
    python synth_sounds.py <输出目录>
"""
import sys
import os
import numpy as np
import wave

SR = 22050  # 采样率：铃声上限 ~3 kHz，22.05 kHz 足够且体积减半


def partials(freq, dur, amps, decays, detune=0.0, phase=0.0):
    """一条带泛音列与逐泛音衰减的基音轨。

    amps/decays 的第 i 项对应第 i 个泛音（频率倍数由 PARTIAL_RATIOS 给出）。
    每个泛音独立指数衰减，让高频先消失 —— 这是「铃声」而不是「电子音」的关键。
    """
    n = int(SR * dur)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for ratio, amp, decay in zip(PARTIAL_RATIOS, amps, decays):
        if amp == 0.0:
            continue
        f = freq * ratio * (1.0 + (detune if ratio > 1.0 else 0.0))
        env = np.exp(-t / decay)
        out += amp * env * np.sin(2 * np.pi * f * t + phase * ratio)
    return out


PARTIAL_RATIOS = (1.0, 2.01, 3.02, 4.06, 5.4, 6.8)
# 钟琴式泛音配比：基音厚、高次泛音快速消失
BELL = (
    (1.00, 2.2, 0.0),  # 基音衰减另给（见 note()）
)


def note(freq, dur, gain=1.0, attack=0.004, decay=0.9, bright=0.35, detune=0.0012):
    """一个钟琴音符：起音极短、指数衰减、高次泛音更快消失。"""
    n = int(SR * dur)
    t = np.arange(n) / SR
    amps = (1.0, bright * 0.55, bright * 0.32, bright * 0.18, bright * 0.09, bright * 0.05)
    decays = (decay, decay * 0.55, decay * 0.38, decay * 0.26, decay * 0.18, decay * 0.13)
    out = partials(freq, dur, amps, decays, detune=detune)
    if attack > 0:
        a = max(1, int(SR * attack))
        out[:a] *= np.sin(np.linspace(0, np.pi / 2, a)) ** 2
    # 收尾 15 ms 淡出，避免末尾出现咔哒声
    f = min(n, int(SR * 0.015))
    if f > 0:
        out[n - f:] *= np.linspace(1, 0, f)
    return out * gain


def layer(total_dur, events):
    """把 (起始秒, 波形) 事件叠进一条总时长的静音轨。"""
    out = np.zeros(int(SR * total_dur))
    for start, wave_data in events:
        i = int(SR * start)
        j = min(len(out), i + len(wave_data))
        if i >= len(out):
            continue
        out[i:j] += wave_data[: j - i]
    return out


def normalize(sig, peak=0.72):
    m = float(np.max(np.abs(sig))) if len(sig) else 0.0
    return sig if m == 0 else sig * (peak / m)


def soft_limit(sig):
    """tanh 软限幅：叠加后的峰值圆润收口，不产生数字削波。"""
    return np.tanh(sig * 1.15) / np.tanh(1.15)


def write_wav(path, sig):
    data = np.clip(sig, -1.0, 1.0)
    pcm = (data * 32767.0).astype('<i2')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return len(pcm) * 2


# ── 三档音色 ────────────────────────────────────────────────────────────────

def complete():
    """舒缓：C6-E6-G6 上行琶音，音符互相交叠、长衰减 —— 收工的风铃声。"""
    notes = [(0.00, 1046.50), (0.26, 1318.51), (0.52, 1567.98)]  # C6 E6 G6
    events = [(t, note(f, 1.9, gain=1.0, decay=1.15, bright=0.30)) for t, f in notes]
    # 尾巴垫一层低八度，让结束感更松弛
    events.append((0.52, note(783.99, 2.0, gain=0.42, decay=1.3, bright=0.22)))
    return normalize(soft_limit(layer(2.6, events)), 0.68)


def assist():
    """急促：A5-E6 三轮连击，短衰减、间隔 0.24 s —— 明显是「来一下」。"""
    events = []
    for k in range(3):
        base = k * 0.24
        events.append((base, note(880.00, 0.30, gain=1.0, decay=0.11, bright=0.55)))
        events.append((base + 0.09, note(1318.51, 0.26, gain=0.92, decay=0.09, bright=0.60)))
    return normalize(soft_limit(layer(0.95, events)), 0.80)


def alert():
    """警醒：E5 与降 E5 交替的下降小二度 ×2 —— 出事了的音。"""
    events = []
    for k in range(2):
        base = k * 0.46
        events.append((base, note(659.26, 0.52, gain=1.0, decay=0.30, bright=0.5)))
        events.append((base + 0.22, note(622.25, 0.52, gain=0.95, decay=0.30, bright=0.5)))
    return normalize(soft_limit(layer(1.30, events)), 0.75)


def blip():
    """确认音：单声短「叮」，用于试听/开工等不需要打扰的场合。"""
    return normalize(layer(0.55, [(0.0, note(1318.51, 0.5, gain=1.0, decay=0.22, bright=0.45))]), 0.6)


SOUNDS = {
    'complete': complete,
    'assist': assist,
    'alert': alert,
    'blip': blip,
}


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    for name, builder in SOUNDS.items():
        sig = builder()
        path = os.path.join(out_dir, name + '.wav')
        size = write_wav(path, sig)
        dur = len(sig) / SR
        print(f'{name:9s} {dur:5.2f}s  {size / 1024:6.1f} KiB  peak={float(np.max(np.abs(sig))):.3f}  {path}')


if __name__ == '__main__':
    main()
