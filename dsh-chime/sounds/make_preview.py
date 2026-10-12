#!/usr/bin/env python3
"""生成自包含的铃声试听页 preview.html（音频以 base64 内嵌，双击即可听）。

为什么要有这个页面：DSH 里的响铃链路上有两段完全不同的东西——
「音频文件本身在浏览器里放出来是什么样」和「DSH 客户端插件有没有被加载」。
出问题时这两段很难分开看。这个页面把第一段单独拎出来：不经过 DSH、不经过网络，
打开就能听到四种音色，用来确认「文件对不对、系统有没有声音」。

用法：python make_preview.py
"""
import base64
import os

HERE = os.path.dirname(os.path.abspath(__file__))

CLIPS = [
    ('complete', '工作完成 · 舒缓琶音', 'C6-E6-G6 上行琶音，2.6 秒长衰减，音量再轻 20%。后台把活干完时响的就是它。'),
    ('assist', '需要你协助 · 三轮连击', 'A5-E6 三轮连击，0.95 秒。agent 问你问题、计划等你批准、卡住或出错时响它。'),
    ('alert', '出错 · 下降小二度', 'E5 与降 E5 交替的下降小二度 ×2，1.3 秒。这是备用音色，可在设置里给「出错」单独换。'),
    ('blip', '轻提示 · 单声叮', '0.55 秒的单声短叮。用于试听、以及失败时的兜底音。'),
]

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-chime 铃声试听</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0d1117; color: #e6edf3;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 12px; margin-bottom: 22px; }
  .grid { display: grid; gap: 12px; max-width: 720px; }
  .card { border: 1px solid #30363d; border-radius: 12px; padding: 14px 16px; background: #161b22;
          display: flex; align-items: center; gap: 16px; }
  .card:hover { border-color: #58a6ff; }
  .meta { flex: 1; }
  .name { font-weight: 600; }
  .desc { color: #8b949e; font-size: 12px; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px;
           padding: 8px 18px; font-size: 14px; cursor: pointer; white-space: nowrap; }
  button:hover { border-color: #58a6ff; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .bar { display: flex; align-items: center; gap: 12px; margin: 22px 0 8px; max-width: 720px; }
  input[type=range] { flex: 1; accent-color: #1f6feb; }
  .status { color: #8b949e; font-size: 12px; }
  .ok { color: #3fb950; }
  .warn { color: #d29922; }
  code { background: #21262d; border-radius: 4px; padding: 1px 5px; }
</style>
</head>
<body>
<h1>dsh-chime 铃声试听</h1>
<div class="sub">这份页面与 DSH 无关：音频已内嵌成 base64，打开就能响，用来单独确认「文件本身」和「你机器有没有声音」。</div>

<div class="bar">
  <button class="primary" id="all">全部依次播放</button>
  <span class="status">音量</span>
  <input type="range" id="vol" min="0" max="100" value="85">
  <span class="status" id="volLabel">85%</span>
</div>
<div class="bar"><span class="status" id="state">音频状态：待解锁（先点任意按钮）</span></div>

<div class="grid" id="grid"></div>

<script>
const CLIPS = __CLIPS__;
let ctx = null, buffers = new Map(), lastPlayed = 0;

function ensure() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}
async function unlock() {
  const audio = ensure();
  if (audio.state !== 'running') { try { await audio.resume() } catch (e) {} }
  document.getElementById('state').textContent =
    '音频状态：' + (audio.state === 'running' ? '已解锁，可以响' : '未解锁（浏览器要一次点击，随便点个按钮）');
  document.getElementById('state').className = 'status ' + (audio.state === 'running' ? 'ok' : 'warn');
  return audio;
}
async function load(name) {
  if (buffers.has(name)) return buffers.get(name);
  const audio = ensure();
  const bytes = Uint8Array.from(atob(CLIPS[name].data), c => c.charCodeAt(0));
  const buf = await audio.decodeAudioData(bytes.buffer);
  buffers.set(name, buf);
  return buf;
}
async function play(name) {
  const audio = await unlock();
  if (audio.state !== 'running') return;
  const buf = await load(name);
  const src = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = (CLIPS[name].gain ?? 1) * (Number(document.getElementById('vol').value) / 100);
  src.buffer = buf; src.connect(gain); gain.connect(audio.destination); src.start();
  lastPlayed = Date.now();
  const btn = document.querySelector('[data-play="' + name + '"]');
  if (btn) { btn.textContent = '播放中…'; setTimeout(() => { btn.textContent = '播放' }, Math.min(600, buf.duration * 250)); }
}

const grid = document.getElementById('grid');
for (const [name, clip] of Object.entries(CLIPS)) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = '<div class="meta"><div class="name"></div><div class="desc"></div></div>'
    + '<button data-play="' + name + '">播放</button>';
  card.querySelector('.name').textContent = clip.title;
  card.querySelector('.desc').textContent = clip.desc
    + '（' + clip.seconds.toFixed(2) + ' 秒，' + Math.round(clip.bytes / 1024) + ' KB）';
  card.querySelector('button').onclick = () => play(name);
  grid.appendChild(card);
}

document.getElementById('all').onclick = async () => {
  for (const name of Object.keys(CLIPS)) {
    await play(name);
    await new Promise(r => setTimeout(r, Math.max(600, CLIPS[name].seconds * 1000 + 250)));
  }
};
const vol = document.getElementById('vol');
vol.oninput = () => { document.getElementById('volLabel').textContent = vol.value + '%'; };
vol.onchange = () => play('complete');
// 任意一次真实交互都顺手解锁（与 DSH 插件里一样的策略）
window.addEventListener('pointerdown', () => unlock(), { passive: true });
unlock().catch(() => {});
</script>
</body>
</html>
"""


def main():
    clips = {}
    total = 0
    for name, title, desc in CLIPS:
        path = os.path.join(HERE, name + '.wav')
        raw = open(path, 'rb').read()
        total += len(raw)
        # 试听页里的档位与插件一致：完成音轻 20%，其余满音量
        gain = 0.8 if name == 'complete' else (0.7 if name == 'blip' else 1.0)
        clips[name] = {
            'title': title,
            'desc': desc,
            'gain': gain,
            'seconds': round((len(raw) - 44) / 2 / 22050, 2),
            'bytes': len(raw),
            'data': base64.b64encode(raw).decode('ascii'),
        }
    out = os.path.join(HERE, 'preview.html')
    with open(out, 'w', encoding='utf-8') as handle:
        handle.write(TEMPLATE.replace('__CLIPS__', __import__('json').dumps(clips, ensure_ascii=False)))
    print(f'{out}  ({os.path.getsize(out) / 1024:.0f} KiB，内嵌 {len(clips)} 段音频，原始音频合计 {total / 1024:.0f} KiB)')
    return out


if __name__ == '__main__':
    main()
