/**
 * dsh-chime — 宿主半边。
 *
 * 职责：把「会话里发生了什么」翻译成少数几条「值得响铃」的通知，
 * 存进一个带序号的环形队列，再用一个 HTTP 路由交给浏览器半边去放声音。
 *
 * 为什么不是宿主端直接播声音：DSH 是桌面 App，但用户真正坐着看的是 Web GUI
 * （浏览器），声音必须由浏览器发。宿主端只当裁判——它能看到全部会话（包括没被
 * 打开的会话和子 agent），浏览器只能看到自己打开的那一个。
 *
 * 判定规则见 README 的「触发规则表」。核心取舍：宁可少响，不可乱响——
 * 一次误报（比如子 agent 干活也响）就会让用户把插件关掉。
 */
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { decide } from './rules.js'

/** 铃声资源目录（随包发布，不用用户配置）。 */
const SOUND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds')
const SOUND_FILES = new Set(['complete.wav', 'assist.wav', 'alert.wav', 'blip.wav'])
const ROUTE = '/dsh-chime'
/** 前缀路由必须无尾斜杠（Web 服务器按 `${prefix}/` 比较），所以这里存不带斜杠的一段。 */
const SOUND_PATH = '/sounds'
/**
 * 用户自定义铃声的存放位置。
 *
 * 刻意放在 `$DSH_HOME` 而不是插件目录里：插件目录是 git 仓库（也可能被重新 link 安装），
 * 把用户上传的音频写进去会变成"仓库里突然多出几个二进制文件"的脏状态。放 DSH_HOME
 * 还有第二个好处——升级、重装、甚至删掉插件目录再拉一次，用户自己的铃声都还在。
 *
 * 惰性求值（不是模块级常量）：DSH_HOME 决定目录，而这个环境变量在测试里要能被改写。
 * 算死了就只能往用户真实的 ~/.dsh 里写——测试污染真实数据是绝对不能接受的事。
 */
const customDir = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-chime', 'sounds')
/** 自定义铃声接受的扩展名 → MIME。 */
const CUSTOM_TYPES = new Map([
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.webm', 'audio/webm'],
])
/** 单个自定义铃声上限（按解码后的字节算；base64 会胀大 4/3）。 */
const MAX_CUSTOM_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_BODY = Math.ceil(MAX_CUSTOM_BYTES * 4 / 3) + 64 * 1024
/** 队列保留窗口：超过这个年龄的通知不再下发（防止 DSH 重启后补响旧铃）。 */
const NOTIFY_TTL_MS = 5 * 60 * 1000
/** 队列上限：只留最近的若干条，避免长时间无人查看时无限增长。 */
const MAX_QUEUE = 50

/** 进程内单调时钟起点：/dsh-chime/status 用它报「插件活了多久」。 */
const STARTED_AT = Date.now()

/** 插件名（patch 里的 name 必须与之一致，否则 Loader 报 loaded-without-registering）。 */
export const name = 'dsh-chime'
/** webServer 是硬依赖：没有 Web 载体就没有铃声通道，硬等比静默失败更好排查。 */
export const inject = ['webServer']

/** 应用插件。 */
export function apply(ctx, config = {}) {
  const cfg = {
    /** 总开关：关掉后连通知都不入队（浏览器半边也就不会响）。 */
    enabled: config.enabled !== false,
    /** 子 agent 会话是否也响铃（默认否：主会话收口时会一并结束）。 */
    notifySubagentSessions: config.notifySubagentSessions === true,
  }

  /** 通知队列：seq 单调递增，浏览器按 seq 拉增量。 */
  const queue = []
  let nextSeq = 1
  /** 每个会话本轮是否已经因为「等用户」响过——避免提问后 turn 结束再来一次。 */
  const assistPending = new Map()
  /** 运行期计数：/dsh-chime/status 直接暴露，用来确认「真的在监听」而不是装上了没动静。 */
  const stats = { classified: {}, pushed: 0, suppressed: 0 }
  /** 事件 → 计数键：区分 turn/end 的 reason 与不同工具名，否则分不清是没监听还是被规则挡了。 */
  const eventKey = (event) => {
    if (event.type === 'turn/end') {
      const reason = event.data && event.data.reason
      return 'turn/end:' + (reason && reason.kind)
    }
    if (event.type === 'tool/call') return 'tool/call:' + String((event.data && event.data.name) || '')
    return String(event.type)
  }

  const nowMs = () => Date.now()

  function prune() {
    const cutoff = nowMs() - NOTIFY_TTL_MS
    while (queue.length > 0 && (queue[0].time < cutoff || queue.length > MAX_QUEUE)) queue.shift()
  }

  function push(kind, fields) {
    prune()
    stats.pushed += 1
    const item = {
      seq: nextSeq++,
      time: nowMs(),
      kind,
      title: fields.title || '',
      detail: fields.detail || '',
      sound: fields.sound || kind,
      sessionId: fields.sessionId || '',
      agentPreset: fields.agentPreset || '',
    }
    queue.push(item)
    console.log(`[dsh-chime] ${kind}: ${item.title}${item.detail ? ' — ' + item.detail : ''}`)
    // 推给所有在线页面：这是「真·实时」的那一跳，毫秒级、不依赖任何定时器
    broadcast(item)
    return item
  }

  function isSubagent(session) {
    const header = session && session.header
    if (!header) return false
    return header.parentSession !== undefined || header.origin === 'subagent'
  }

  function sessionLabel(session) {
    const header = (session && session.header) || {}
    return {
      sessionId: String((session && session.id) || ''),
      agentPreset: String(header.agentPreset || ''),
    }
  }

  function onSessionEvent(session, event) {
    if (!cfg.enabled) return
    const key = eventKey(event)
    stats.classified[key] = (stats.classified[key] || 0) + 1
    const sub = isSubagent(session)
    if (sub && !cfg.notifySubagentSessions) return
    const label = sessionLabel(session)
    const decision = decide(event)
    if (decision === null) return

    // 「同一轮里问过就不再响第二次」：agent 提问后这一轮多半以非 completed 收尾，
    // 两边都响会变成连环铃，所以在这里记住「本轮已经为等用户响过」。
    if (event.type === 'tool/call') {
      assistPending.set(label.sessionId, true)
    } else if (event.type === 'turn/end') {
      const assisted = assistPending.get(label.sessionId) === true
      assistPending.delete(label.sessionId)
      if (decision.kind === 'assist' && assisted) {
        stats.suppressed += 1
        return
      }
    }

    push(decision.kind, {
      ...label,
      // 子 agent 的通知改个说法，免得和主会话混淆
      title: sub ? (decision.kind === 'assist' ? '子 agent 在等你' : '子任务收工') : decision.title,
      detail: sub ? '来自子 agent 会话' : decision.detail,
      sound: decision.sound,
    })
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-chime: session events')

  // ── SSE 推流：把「宿主 → 浏览器」这一段从 2 秒轮询换成真推送 ──────────────
  // 浏览器定时器在后台标签页会被节流到分钟级，轮询因此最慢要等一分钟；
  // SSE 是一条长连接，宿主一有通知就写下去，后台标签页同样毫秒级到。
  // 轮询路由保留：它现在是「断线补拉」和「不支持 EventSource 时的降级」。
  const streamClients = new Map()
  let streamSeq = 0

  /**
   * 写一帧给某个 SSE 客户端。
   * @param id 客户端 id（断开时用它清理）
   * @param entry 订阅记录（含 res/socket）
   */
  const sseSend = (id, entry, payload) => {
    try {
      entry.socket.write('data: ' + JSON.stringify(payload) + '\n\n')
      return true
    } catch (error) {
      console.warn(`[dsh-chime] SSE 写入失败，断开 ${id}: ${error && error.message || error}`)
      sseDrop(id)
      return false
    }
  }

  function sseDrop(id) {
    const entry = streamClients.get(id)
    if (!entry) return
    streamClients.delete(id)
    for (const off of entry.offs) {
      try { off() } catch (error) { /* 已经断了 */ }
    }
    try { entry.res.end() } catch (error) { /* 已经关了 */ }
  }

  function broadcast(item) {
    for (const [id, entry] of [...streamClients.entries()]) sseSend(id, entry, { ok: true, item })
  }

  // ── 自定义铃声：用户在设置页上传自己的 wav/mp3 ────────────────────────────
  // 内置四个音色是「随包发布、只读」的；用户上传的单独放一层，两者在下拉里合并展示。
  let customSounds = new Map() // 安全名（不含扩展名）→ { file, ext, mime, bytes, mtime }

  async function scanCustomSounds() {
    const next = new Map()
    try {
      const entries = await readdir(customDir(), { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue
        const ext = extname(entry.name).toLowerCase()
        const mime = CUSTOM_TYPES.get(ext)
        if (!mime) continue
        try {
          const info = await stat(join(customDir(), entry.name))
          next.set(safeSoundName(entry.name.slice(0, -ext.length)), {
            file: entry.name, ext, mime, bytes: info.size, mtime: info.mtimeMs,
          })
        } catch (error) { /* 刚好被删了，忽略 */ }
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn(`[dsh-chime] 读取自定义铃声目录失败: ${error.message}`)
      }
    }
    customSounds = next
    return next
  }

  /**
   * 把用户给的文件名收敛成一个安全名字：只留中日韩字母数字与 `-` `_`，其余折成 `-`。
   * 用来做「展示名 / URL 段」，落盘的文件名再从它拼扩展名，避免任何路径穿越的可能。
   */
  function safeSoundName(raw) {
    const trimmed = String(raw || '').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '')
    const cleaned = trimmed
      .replace(/[^\p{Letter}\p{Number}_-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48)
    return cleaned || 'sound'
  }

  /**
   * 从文件头认音频格式。
   *
   * 为什么需要它：有些系统/浏览器上传时给不出带后缀的文件名，只凭扩展名判断会把
   * 明明是好文件拒掉；反过来，只凭扩展名也容易把一个改名的 txt 存成"铃声"。
   * 认不出来就交给调用方拒绝——宁可让用户换个文件，也不留放不出来的垃圾。
   */
  function sniffAudioExt(bytes) {
    if (!bytes || bytes.length < 12) return ''
    const ascii = (offset, length) => bytes.subarray(offset, offset + length).toString('latin1')
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return '.wav'
    if (ascii(0, 4) === 'OggS') return '.ogg'
    if (ascii(0, 4) === 'fLaC') return '.flac'
    if (ascii(4, 4) === 'ftyp') {
      const brand = ascii(8, 4)
      // M4A/MP4 家族；brand 为 M4A / mp42 / isom 等都算容器合法
      return brand.startsWith('M4A') || brand === 'mp42' || brand === 'isom' ? '.m4a' : '.m4a'
    }
    if (ascii(0, 3) === 'ID3') return '.mp3'
    // 没有 ID3 标签的裸 MP3：首字节 0xFF 且次字节高 3 位是 111（MPEG frame sync）
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return '.mp3'
    // WebM/Matroska：EBML 头
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return '.webm'
    return ''
  }

  /** 自定义铃声的公开描述（客户端下拉与此处共用）。 */
  function customSoundList() {
    return [...customSounds.entries()]
      .map(([name, info]) => ({ name, file: info.file, bytes: info.bytes, custom: true, gain: 1 }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }

  function readBody(req, maxBytes) {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks = []
      let total = 0
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > maxBytes) {
          rejectPromise(new Error(`请求体过大（上限 ${Math.round(maxBytes / 1024)} KiB）`))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
      req.on('error', rejectPromise)
    })
  }

  void scanCustomSounds()

  // HTTP 通道：浏览器半边只做两件事——拉通知、取铃声。
  const webServer = ctx.get('webServer')
  if (webServer) {
    const text = (res, body, status = 200, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(body)
    }
    /** 每个路由单独兜异常：插件管理器热重载时同名路由已存在，不该让整个插件注册失败。 */
    const route = (label, spec) => {
      try {
        // prefix 路由的尾斜杠会让 Web 服务器永远匹配不上（它比的是 `${prefix}/`，
        // 于是 '/x/sounds/complete.wav' 对不上 '/x/sounds/'）。这里替调用方兜住这个坑。
        const path = spec.kind === 'prefix' && spec.path.length > 1 && spec.path.endsWith('/')
          ? spec.path.replace(/\/+$/, '')
          : spec.path
        ctx.effect(() => webServer.register({ ...spec, path }), label)
      } catch (error) {
        console.warn(`[dsh-chime] ${label} 注册失败（多半是重复注册）: ${error && error.message || error}`)
      }
    }

    route('dsh-chime: poll route', {
      kind: 'exact',
      path: ROUTE + '/poll',
      handler(req, res) {
        const url = new URL(req.url || '/', 'http://localhost')
        const since = Number(url.searchParams.get('since') || 0)
        prune()
        const items = queue.filter((item) => item.seq > since)
        const lastSeq = queue.length > 0 ? queue[queue.length - 1].seq : Math.max(0, since)
        text(res, JSON.stringify({ ok: true, items, lastSeq, serverTime: nowMs() }))
      },
    })

    route('dsh-chime: test route', {
      kind: 'exact',
      path: ROUTE + '/test',
      handler(req, res) {
        const url = new URL(req.url || '/', 'http://localhost')
        const kind = String(url.searchParams.get('kind') || 'complete')
        const sound = SOUND_FILES.has(kind + '.wav') ? kind : 'blip'
        push('test', { title: '试听', detail: sound, sound })
        text(res, JSON.stringify({ ok: true, sound }))
      },
    })

    route('dsh-chime: stream route', {
      kind: 'exact',
      path: ROUTE + '/stream',
      handler(req, res) {
        const id = 'sse-' + (++streamSeq)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(': dsh-chime stream open\nretry: 2000\n\n')
        const offs = [
          () => res.off('close', onClose),
          () => res.off('error', onClose),
        ]
        function onClose() { sseDrop(id) }
        res.on('close', onClose)
        res.on('error', onClose)
        streamClients.set(id, { res, socket: res, connectedAt: nowMs(), offs })
        prune()
        // 首帧告诉它当前水位：页面据此判断要不要补拉（水位比它本地游标高就补）
        sseSend(id, streamClients.get(id), { ok: true, hello: true, lastSeq: nextSeq - 1, clients: streamClients.size, serverTime: nowMs() })
        console.log(`[dsh-chime] SSE 客户端接入 ${id}（当前 ${streamClients.size} 个）`)
      },
    })

    // 心跳：只发注释行，25 秒一次，防止中间层或浏览器把空闲长连接掐掉
    ctx.effect(() => {
      const handle = setInterval(() => {
        for (const [id, entry] of [...streamClients.entries()]) {
          try {
            entry.socket.write(': ping\n\n')
          } catch (error) { sseDrop(id) }
        }
      }, 25000)
      return () => {
        clearInterval(handle)
        // 插件卸载/热重载时把长连接收干净，否则旧页面会挂在一条没人写的连接上
        for (const id of [...streamClients.keys()]) sseDrop(id)
      }
    }, 'dsh-chime: sse heartbeat')

    route('dsh-chime: sound route', {
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://localhost')
        let pathname = ''
        try {
          pathname = decodeURIComponent(url.pathname)
        } catch (error) {
          text(res, JSON.stringify({ ok: false, error: 'bad path' }), 400)
          return
        }
        if (pathname === ROUTE + '/status') {
          // 诊断口：一条命令就能看出「插件活着吗、监听到什么、为什么没响」
          prune()
          text(res, JSON.stringify({
            ok: true,
            enabled: cfg.enabled,
            notifySubagentSessions: cfg.notifySubagentSessions,
            uptimeMs: nowMs() - STARTED_AT,
            queue: queue.length,
            lastSeq: nextSeq - 1,
            streamClients: streamClients.size,
            pendingSessions: assistPending.size,
            customSounds: customSounds.size,
            customDir: customDir(),
            stats,
            sounds: [...SOUND_FILES],
          }))
          return
        }
        const base = ROUTE + SOUND_PATH

        // 自定义铃声的管理口。必须排在通用 sounds 处理之前——否则会被当成文件名而 404。
        if (pathname === base + '/custom') {
          const method = String(req.method || 'GET').toUpperCase()

          if (method === 'GET') {
            await scanCustomSounds()
            text(res, JSON.stringify({
              ok: true,
              dir: customDir(),
              accepted: [...CUSTOM_TYPES.keys()],
              maxBytes: MAX_CUSTOM_BYTES,
              sounds: customSoundList(),
            }))
            return
          }

          if (method === 'POST') {
            let body
            try {
              body = await readBody(req, MAX_UPLOAD_BODY)
            } catch (error) {
              text(res, JSON.stringify({ ok: false, error: String(error && error.message || error) }), 413)
              return
            }
            let payload
            try {
              payload = JSON.parse(body)
            } catch (error) {
              text(res, JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }), 400)
              return
            }
            const data = String(payload && payload.dataBase64 || '')
            if (!data) {
              text(res, JSON.stringify({ ok: false, error: '缺少 dataBase64' }), 400)
              return
            }
            let bytes
            try {
              bytes = Buffer.from(data, 'base64')
            } catch (error) {
              text(res, JSON.stringify({ ok: false, error: 'base64 解码失败' }), 400)
              return
            }
            if (bytes.length === 0) {
              text(res, JSON.stringify({ ok: false, error: '内容为空' }), 400)
              return
            }
            if (bytes.length > MAX_CUSTOM_BYTES) {
              text(res, JSON.stringify({ ok: false, error: `超过上限 ${Math.round(MAX_CUSTOM_BYTES / 1024 / 1024)} MiB` }), 413)
              return
            }
            // 扩展名既看用户给的文件名，也看容器头（有些系统给的 name 不带后缀）；
            // 两者都不认识就拒绝——不做「先存下再说」的猜测，免得留一堆放不出来的文件。
            const rawName = String(payload && payload.name || '')
            let ext = extname(rawName).toLowerCase()
            if (!CUSTOM_TYPES.has(ext)) ext = sniffAudioExt(bytes)
            const mime = CUSTOM_TYPES.get(ext)
            if (!mime) {
              text(res, JSON.stringify({
                ok: false,
                error: `不认识的音频格式（按扩展名与文件头都判不出来），接受：${[...CUSTOM_TYPES.keys()].join(' ')}`,
              }), 415)
              return
            }
            const name = safeSoundName(payload && payload.label ? payload.label : rawName)
            const file = `${name}${ext}`
            try {
              await mkdir(customDir(), { recursive: true })
              await writeFile(join(customDir(), file), bytes)
              await scanCustomSounds()
            } catch (error) {
              text(res, JSON.stringify({ ok: false, error: `写入失败：${error && error.message || error}` }), 500)
              return
            }
            console.log(`[dsh-chime] 自定义铃声已保存：${file}（${Math.round(bytes.length / 1024)} KiB）`)
            text(res, JSON.stringify({ ok: true, name, file, bytes: bytes.length, sounds: customSoundList() }))
            return
          }

          if (method === 'DELETE') {
            const wanted = safeSoundName(url.searchParams.get('name') || '')
            await scanCustomSounds()
            const hit = customSounds.get(wanted)
            if (!hit) {
              text(res, JSON.stringify({ ok: false, error: '没有这个自定义铃声' }), 404)
              return
            }
            try {
              await unlink(join(customDir(), hit.file))
              await scanCustomSounds()
            } catch (error) {
              text(res, JSON.stringify({ ok: false, error: `删除失败：${error && error.message || error}` }), 500)
              return
            }
            text(res, JSON.stringify({ ok: true, name: wanted, sounds: customSoundList() }))
            return
          }

          text(res, JSON.stringify({ ok: false, error: 'method not allowed' }), 405)
          return
        }

        if (pathname !== base && !pathname.startsWith(base + '/')) {
          text(res, JSON.stringify({ ok: false, error: 'not found' }), 404)
          return
        }
        // 白名单校验：内置四首认文件名，用户上传的认「扫描出来的真实文件」；
        // 两条都只按名字取，绝不拿请求里的路径去拼（%2e%2e%2f 这类进不来）。
        const name = pathname === base ? '' : pathname.slice(base.length + 1)
        const builtin = SOUND_FILES.has(name)
        let custom = null
        if (!builtin) {
          await scanCustomSounds()
          custom = [...customSounds.values()].find((info) => info.file === name) || null
        }
        if (!builtin && custom === null) {
          text(res, JSON.stringify({ ok: false, error: 'unknown sound' }), 404)
          return
        }
        try {
          const [body, info] = builtin
            ? await Promise.all([readFile(resolve(SOUND_DIR, normalize(name))), stat(resolve(SOUND_DIR, normalize(name)))])
            : await Promise.all([readFile(join(customDir(), custom.file)), stat(join(customDir(), custom.file))])
          res.writeHead(200, {
            'Content-Type': builtin ? 'audio/wav' : custom.mime,
            'Content-Length': String(info.size),
            'Cache-Control': 'public, max-age=3600',
          })
          res.end(body)
        } catch (error) {
          text(res, JSON.stringify({ ok: false, error: String(error && error.message || error) }), 404)
        }
      },
    })

    console.log(`[dsh-chime] 铃声通道就绪: ${ROUTE}/poll, ${ROUTE}/sounds/<name>.wav`)
  } else {
    console.warn('[dsh-chime] 没有 webServer，浏览器半边收不到铃声（仅桌面 App 场景无 Web GUI）')
  }

  /**
   * 测试出口（Cordis 不使用 apply 的返回值，因此对生产零影响）。
   * 有了它，tests/sse-http.test.mjs 能把真实 handler 挂到真实 http 服务器上跑，
   * 而不是只对着假 req/res 断言——SSE 这种协议细节，假对象很容易"测过但实际不通"。
   */
  return { push, stats, queue, get streamClients() { return streamClients.size } }
}
