/**
 * 用 headless Edge + CDP 真跑一次铃声播放，测量「有没有声音出来」。
 *
 * 为什么值得写这个：耳朵听不到的时候，必须能把「文件坏了 / 浏览器放不出来 / DSH 没集成好」
 * 分成三件事分别证明。这个脚本证明的是中间那件——同一个浏览器引擎、同一套 Web Audio API、
 * 同一批 WAV 字节，真播放并用 AnalyserNode 量出音频信号。
 *
 * 局限要说清：headless 不接扬声器，所以它证明「产生了音频信号」，不证明「你的音箱响了」；
 * 后者由 preview.html 给人听来闭环。
 *
 * 用法：node tests/render-audio.mjs [previewUrl]
 *   默认跑 file:// 上的 sounds/preview.html（页内用 base64 内嵌音频）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const previewPath = join(here, '..', 'sounds', 'preview.html')
const PORT = 9333 + (process.pid % 200)

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = process.env.EDGE_PATH || EDGE_CANDIDATES.find((p) => existsSync(p))
if (!edge) {
  console.log('SKIP: 找不到 Edge，跳过渲染验证')
  process.exit(0)
}
if (!existsSync(previewPath)) {
  console.log('SKIP: 没有 sounds/preview.html，先跑 python sounds/make_preview.py')
  process.exit(0)
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-chime-edge-'))
const child = spawn(edge, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio=false',
  // 让页面无需用户手势即可出声：这里测的是「音频通路」，不是自动播放策略
  '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch (error) { /* 还在启动 */ }
    await sleep(250)
  }
  throw new Error('Edge 调试端口没起来')
}

async function main() {
  const wsUrl = await waitForTarget()
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    let msg
    try { msg = JSON.parse(event.data) } catch (error) { return }
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(msg.error.message))
    else entry.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: process.argv[2] || pathToFileURL(previewPath).href })
  await sleep(1500)

  // 探针：在页面里跑真实的播放，并用 AnalyserNode 采集输出信号
  const probe = `(async () => {
    const out = { clips: {} };
    const audio = await unlock();
    out.ctxState = audio.state;
    out.sampleRate = audio.sampleRate;
    for (const name of Object.keys(CLIPS)) {
      const buf = await load(name);
      out.clips[name] = { durationMs: Math.round(buf.duration * 1000), channels: buf.numberOfChannels, sampleRate: buf.sampleRate };
    }
    // 带测量地播一遍「需协助」音（最该响亮的那个）
    const measured = await (async () => {
      const name = 'assist';
      const buf = await load(name);
      const src = audio.createBufferSource();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 2048;
      const gain = audio.createGain();
      gain.gain.value = CLIPS[name].gain ?? 1;
      src.buffer = buf;
      src.connect(analyser); analyser.connect(gain); gain.connect(audio.destination);
      const data = new Float32Array(analyser.fftSize);
      let peak = 0, frames = 0, nonZero = 0;
      src.start();
      const until = performance.now() + buf.duration * 1000;
      while (performance.now() < until) {
        analyser.getFloatTimeDomainData(data);
        let local = 0;
        for (let i = 0; i < data.length; i += 1) { const v = Math.abs(data[i]); if (v > local) local = v }
        if (local > peak) peak = local;
        if (local > 0.0005) nonZero += 1;
        frames += 1;
        await new Promise(r => setTimeout(r, 16));
      }
      return { peak: Number(peak.toFixed(5)), frames, framesWithSignal: nonZero };
    })();
    out.measurement = measured;
    out.gridCards = document.querySelectorAll('.card').length;
    out.stateLine = document.getElementById('state').textContent;
    return out;
  })()`

  const result = await send('Runtime.evaluate', {
    expression: probe,
    awaitPromise: true,
    returnByValue: true,
  })

  const report = result.result && result.result.value
  const text = JSON.stringify(report, null, 2)
  console.log(text)
  const outFile = join(here, 'render-audio-report.json')
  writeFileSync(outFile, text + '\n')

  ws.close()
  child.kill()

  // 判定：解码时长合理 + 播放期间确实测到信号
  const problems = []
  if (!report) problems.push('页面没有返回探针结果')
  else {
    if (report.ctxState !== 'running') problems.push(`AudioContext 没跑起来（${report.ctxState}）`)
    for (const [name, info] of Object.entries(report.clips || {})) {
      if (!(info.durationMs > 0)) problems.push(`${name} 解码后时长异常：${info.durationMs}ms`)
    }
    if (!(report.measurement && report.measurement.peak > 0.05)) problems.push('播放期间没测到音频信号')
    if (!(report.measurement && report.measurement.framesWithSignal > 5)) problems.push('有信号的帧太少，像是静音')
  }
  if (problems.length > 0) {
    console.error('渲染验证失败：\n - ' + problems.join('\n - '))
    process.exit(1)
  }
  console.log(`\n渲染验证通过：AudioContext=${report.ctxState}，峰值=${report.measurement.peak}，有信号帧=${report.measurement.framesWithSignal}/${report.measurement.frames}`)
}

main().catch((error) => {
  console.error('渲染验证异常：', error && error.message || error)
  try { child.kill() } catch (e) { /* 忽略 */ }
  process.exit(1)
})
