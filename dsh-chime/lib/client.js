/**
 * dsh-chime — 浏览器半边（client bundle）。
 *
 * 加载格式与 dsh-meme / dsh-pet 同款：window.__ModuleLoader__.load({ id, factory })，
 * id 必须等于 Loader 条目名（dsh-chime），否则报 loaded-without-registering。
 *
 * 职责：轮询宿主 /dsh-chime/poll 拿通知 → 用 Web Audio 放对应铃声 → 设置页里
 * 给用户一个能自己调的面板（开关/音量/静音时段/试听）。
 *
 * 两个刻意的设计：
 *  1. 设置存 localStorage 而不是回宿主：换浏览器/清缓存只影响外观，不会让宿主
 *     因为一个坏配置起不来；宿主那边只负责「发生了什么事」。
 *  2. 铃声用 Web Audio 播而不是 <audio>：解码一次反复播，音头没有解码延迟，
 *     而且能在同一 AudioContext 里做音量与并发控制。
 */

window.__ModuleLoader__.load({
  id: 'dsh-chime',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const API = '/dsh-chime'
    /**
     * 兜底轮询节奏。实时性由 SSE 推送负责（毫秒级），这里只在推送断开时接管，
     * 所以可以放得很松——它唯一的职责是「别让通知永远卡在队列里」。
     */
    const POLL_MS = 20000
    /** 标签页在后台时更松（浏览器本来就会节流，推送才是后台场景的主力）。 */
    const HIDDEN_POLL_MS = 45000
    const STORE_KEY = 'dsh-chime.settings.v1'
    const CURSOR_KEY = 'dsh-chime.cursor.v1'
    /**
     * 一条通知的寿命：超过 STALE_MS 就不响了（宿主重启、断线很久回来，不该补响一耳朵旧铃）。
     *
     * 这里曾经是「8 秒算新鲜、90 秒算过期」，中间那段死区什么都不做——很坑自己：
     * 页面在后台时浏览器会把定时器节流到分钟级，等用户切回来，通知早掉进死区，
     * 表现就是「怎么没响」，日志里还只有一句「过期通知，忽略」，看着像插件坏了。
     * 现在两条线合一：一分钟内的提醒照响（用户切回来就该知道刚才发生了什么），
     * 一分钟前的才静默丢弃。宿主那边队列本身 5 分钟就清，双重兜底。
     */
    const STALE_MS = 120 * 1000
    const FRESH_MS = 120 * 1000
    /** 两句铃声之间至少隔这么久，避免连环通知把人耳朵吵炸。 */
    const COOLDOWN_MS = 1500
    /** 声音档位：完成音轻一点（本来就该舒缓），需协助音用满音量。 */
    const GAIN = { complete: 0.8, assist: 1.0, alert: 0.95, blip: 0.7 }

    /** 一条通知该有多急：数值越大越优先响。 */
    const priorityOf = (kind) => (kind === 'assist' || kind === 'alert' ? 2 : 1)

    const SOUNDS = {
      complete: { file: 'complete.wav', label: '舒缓琶音', hint: '工作完成' },
      assist: { file: 'assist.wav', label: '三轮连击', hint: '需要你协助' },
      alert: { file: 'alert.wav', label: '下降小二度', hint: '出错了' },
      blip: { file: 'blip.wav', label: '单声叮', hint: '轻提示' },
    }

    const DEFAULTS = {
      enabled: true,
      volume: 0.85,
      quietFrom: '',
      quietTo: '',
      completeSound: 'complete',
      assistSound: 'assist',
      notifyDesktop: false,
      notifyTitle: true,
      /** 响过没人理就升级：只追「需协助」类，完成音不追着人跑。 */
      escalateEnabled: true,
      /** 首响后多久没人理就开始升级（秒），实际使用时会收敛到 5–600。 */
      escalateDelaySec: 30,
    }

    /**
     * 设置收敛：只认 DEFAULTS 里的 key（未知字段忽略、缺失字段补默认），
     * volume 越界（负数 / >1 / 非数字）收敛到合法区间。
     * 纯函数，tests/settings-smoke.test.mjs 从本文件抽出执行。
     */
    function clampSettings(input) {
      const out = { ...DEFAULTS }
      if (input && typeof input === 'object') {
        for (const key of Object.keys(DEFAULTS)) {
          if (input[key] !== undefined) out[key] = input[key]
        }
      }
      const v = Number(out.volume)
      out.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULTS.volume
      return out
    }

    /** 从 localStorage 原文解析设置；缺失/损坏 JSON → 全套默认值（不抛）。 */
    function readSettingsFrom(raw) {
      if (!raw) return { ...DEFAULTS }
      try {
        return clampSettings(JSON.parse(raw))
      } catch (error) {
        return { ...DEFAULTS }
      }
    }

    function readSettings() {
      try {
        return readSettingsFrom(window.localStorage.getItem(STORE_KEY))
      } catch (error) {
        return { ...DEFAULTS }
      }
    }

    function writeSettings(next) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next))
      } catch (error) { /* 隐私模式等写不进去：本次会话仍然生效 */ }
    }

    /** "HH:MM" 或空串；非法值当作未设置。 */
    function parseClock(value) {
      if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value.trim())) return null
      const [h, m] = value.trim().split(':').map(Number)
      if (h > 23 || m > 59) return null
      return h * 60 + m
    }

    /** 静音时段判定：支持跨零点（如 23:00–07:00）。 */
    function inQuietHours(settings, now = new Date()) {
      const from = parseClock(settings.quietFrom)
      const to = parseClock(settings.quietTo)
      if (from === null || to === null || from === to) return false
      const cur = now.getHours() * 60 + now.getMinutes()
      return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to)
    }

    /**
     * 音色清单：内置四个 + 用户上传的（customs 由调用方传入）。
     * 纯函数，tests/settings-smoke.test.mjs 从本文件抽出执行。
     */
    function soundOptionsOf(customs) {
      const builtin = Object.keys(SOUNDS).map((name) => ({
        name, builtin: true, label: SOUNDS[name].label, hint: SOUNDS[name].hint, gain: GAIN[name] || 1,
      }))
      const mine = (customs || []).map((entry) => ({
        name: entry.name, builtin: false, custom: true, file: entry.file,
        label: entry.name, hint: `自定义 · ${Math.round((entry.bytes || 0) / 1024)} KB`, gain: 1,
      }))
      return [...builtin, ...mine]
    }

    /**
     * 把一个音色名解析成「实际播哪个文件」（customs 由调用方传入）。
     * 自定义音色的 URL 用的是上传落盘的文件名（可能带 .mp3 这种扩展名），
     * 而设置里存的是音色名——所以这里必须做一层映射，不能直接把名字当文件名用。
     * 找不到就回退到「单声叮」并明说，而不是静默什么都不响。
     */
    function resolveSoundOf(name, customs) {
      if (SOUNDS[name]) return { file: name, gain: GAIN[name] || 1, hint: SOUNDS[name].hint }
      const custom = (customs || []).find((entry) => entry.name === name)
      if (custom) return { file: custom.file, gain: 1, hint: `自定义（${custom.name}）` }
      return { file: 'blip', gain: GAIN.blip || 1, hint: `${SOUNDS.blip.hint}（原音色已不可用，已回退）` }
    }

    /** 删掉一个自定义音色后，设置里指向它的选项该回退成什么（没有要改的就是空对象）。 */
    function soundPatchForDeleted(settings, name) {
      const patch = {}
      if (settings.completeSound === name) patch.completeSound = 'complete'
      if (settings.assistSound === name) patch.assistSound = 'assist'
      return patch
    }

    /**
     * 设置页「怎么用」里展示的速查内容。
     *
     * 为什么以数据形式放在源码里、而不是从 CHEATSHEET.md 读进来：客户端 bundle 拿不到文件系统，
     * 也不该为一段说明去 fetch 一个 md。代价是文案有**两份**（这里 + CHEATSHEET.md），
     * 所以两件事一起做：① 内容按「使用者的疑问」组织，和速查卡同源同措辞；
     * ② `tests/settings-smoke.test.mjs` 断言每个分类和关键条目都在渲染结果里——
     * 「把设置页说明删空了」这种回归会当场变红，而不是等用户发现设置页没说明。
     */
    const HELP_TOPICS = [
      {
        name: '什么时候响',
        rows: [
          ['活干完了', '舒缓：C6-E6-G6 上行琶音（一轮正常收尾）'],
          ['需要你出面', '急促：三轮连击（问你问题 / 计划待批准 / 卡住了 / 出错了）'],
          ['不响的情况', '你自己按的停、被中断、超长自动续跑；子 agent 干活也不单独响'],
        ],
      },
      {
        name: '常用操作',
        rows: [
          ['听不到声音', '先点上面的「解锁并加载」——浏览器规定页面收到第一次点击前不准出声'],
          ['换铃声', '「完成时 / 需协助时」两个下拉；想用自己的音频就上传到「自定义铃声」'],
          ['别在半夜响', '填「静音时段」（如 23:00 至 07:00，支持跨零点；留空 = 全天都响）'],
          ['响过没人理要更响', '打开「没人理就升级」：首次延迟后追着重响、音量逐次抬高，最多 3 次'],
          ['一键验证全链路', '点「让宿主发一条测试通知」——走完整链路：宿主 → 网页 → 响铃'],
        ],
      },
      {
        name: '出问题先看哪',
        rows: [
          ['音频状态徽章', '「未解锁」就先点解锁；「实时推送已连接」表示一切正常（宿主一有通知立刻到）'],
          ['最近的通知', '每条都写明「响了 / 被浏览器拦下 / 静音时段跳过 / 已合并」，这是第一现场'],
          ['还不行', '点「看诊断信息」，或新开标签页访问 http://127.0.0.1:19387/dsh-chime/status'],
        ],
      },
      {
        name: '要记住的取舍',
        rows: [
          ['只响最重要的那声', '一批通知同时到达时只响最急的一条，其余记「已合并」——防连环轰炸，列表里能看到'],
          ['完成音更轻', '完成音比需协助音轻 20%（舒缓音不该吓人），滑杆是总音量'],
        ],
      },
    ]

    /** 把 HELP_TOPICS 渲染成 React 节点（h = React.createElement，由调用方给）。 */
    function buildHelpNodes(h) {
      return HELP_TOPICS.map((topic) => h('div', { className: 'help-topic', key: topic.name },
        h('div', { className: 'help-topic-name' }, topic.name),
        h('div', { className: 'help-rows' },
          topic.rows.map(([what, how]) => h('div', { className: 'help-row', key: what },
            h('span', { className: 'help-what' }, what),
            h('span', { className: 'help-how' }, how),
          )),
        ),
      ))
    }

    function createPlayer() {
      let ctx = null
      const buffers = new Map()
      let lastPlayAt = 0

      function ensureCtx() {
        if (ctx) return ctx
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        try {
          ctx = new Ctor()
        } catch (error) {
          ctx = null
        }
        return ctx
      }

      async function load(name) {
        if (buffers.has(name)) return buffers.get(name)
        const audio = ensureCtx()
        if (!audio) return null
        const url = `${API}/sounds/${name}.wav`
        const res = await fetch(url, { cache: 'force-cache' })
        if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
        const bytes = await res.arrayBuffer()
        const buffer = await audio.decodeAudioData(bytes)
        buffers.set(name, buffer)
        return buffer
      }

      async function unlock() {
        const audio = ensureCtx()
        if (!audio) return false
        if (audio.state !== 'running') {
          try { await audio.resume() } catch (error) { /* 等待真实手势 */ }
        }
        return audio.state === 'running'
      }

      async function play(name, volume) {
        const audio = ensureCtx()
        if (!audio) return false
        if (audio.state !== 'running') {
          try { await audio.resume() } catch (error) { /* 下面按失败处理 */ }
        }
        if (audio.state !== 'running') return false
        const buffer = await load(name).catch(() => null)
        if (!buffer) return false
        const source = audio.createBufferSource()
        const gain = audio.createGain()
        gain.gain.value = Math.max(0, Math.min(1, Number(volume) || 0))
        source.buffer = buffer
        source.connect(gain)
        gain.connect(audio.destination)
        source.start()
        lastPlayAt = Date.now()
        return true
      }

      return {
        state: () => (ctx ? ctx.state : 'closed'),
        hasCtx: () => ctx !== null,
        unlock,
        play,
        preload: (names) => Promise.all(names.map((n) => load(n).catch(() => null))),
        /** 冷却判定：返回 true 表示现在可以响。 */
        ready: () => Date.now() - lastPlayAt >= COOLDOWN_MS,
        markPlayed: () => { lastPlayAt = Date.now() },
      }
    }

    const CSS = [
      '.chime-panel{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.chime-panel .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.chime-panel .row.between{justify-content:space-between}',
      '.chime-panel .section-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;margin:2px 0 -6px}',
      '.chime-panel .hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.chime-panel .card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.chime-panel .switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;transition:background .15s ease;flex:none;display:inline-block}',
      '.chime-panel .switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s ease}',
      '.chime-panel .switch.on{background:var(--dsw-alias-brand-primary)}',
      '.chime-panel .switch.on::after{transform:translateX(16px)}',
      '.chime-panel input[type=range]{flex:1;min-width:140px;accent-color:var(--dsw-alias-brand-primary)}',
      '.chime-panel input[type=text],.chime-panel select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font-size:13px;outline:none}',
      '.chime-panel input[type=text]:focus,.chime-panel select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.chime-panel input[type=text]{width:72px;text-align:center}',
      '.chime-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}',
      '.chime-panel button:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.chime-panel button.btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.chime-panel .badge{font-size:11px;border-radius:999px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.chime-panel .badge.ok{color:#2ea043;border-color:#2ea04366}',
      '.chime-panel .badge.warn{color:#d29922;border-color:#d2992266}',
      '.chime-panel .log{font-size:11px;color:var(--dsw-alias-label-secondary);max-height:132px;overflow:auto;display:flex;flex-direction:column;gap:3px}',
      '.chime-panel .log .line{display:flex;gap:8px}',
      '.chime-panel .log .t{flex:none;opacity:.65;font-variant-numeric:tabular-nums}',
      // 「怎么用」折叠卡：原生 details，样式只负责让它看起来像一张卡
      '.chime-panel .chime-help{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}',
      '.chime-panel .chime-help>summary{cursor:pointer;list-style:none;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}',
      '.chime-panel .chime-help>summary::-webkit-details-marker{display:none}',
      '.chime-panel .chime-help .help-title{font-weight:600}',
      '.chime-panel .chime-help .help-body{display:flex;flex-direction:column;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.chime-panel .help-topic-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}',
      '.chime-panel .help-rows{display:flex;flex-direction:column;gap:4px;margin-top:4px}',
      '.chime-panel .help-row{display:flex;gap:10px;font-size:12px;line-height:1.55}',
      '.chime-panel .help-what{flex:none;width:132px;color:var(--dsw-alias-label-primary)}',
      '.chime-panel .help-how{color:var(--dsw-alias-label-secondary)}',
    ].join('')

    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => styleEl.remove(), 'dsh-chime: styles')

      const player = createPlayer()
      let settings = readSettings()
      const listeners = new Set()
      const recent = []
      /**
       * 当前传输方式：push=true 表示 SSE 长连接活着（毫秒级），false 表示退回轮询兜底。
       * 声明放在最前面——snapshot() 会读它，而 snapshot 是设置页首帧就要用的。
       */
      const mode = { push: false, since: 0 }
      /**
       * 用户上传的自定义铃声（宿主扫描 `$DSH_HOME/dsh-chime/sounds` 得来的）。
       * 它们和内置音色一起出现在下拉里；增益按 1 算（用户自己的文件，不该被我们再削一刀）。
       */
      let customs = []
      /**
       * 升级链实例（createEscalation 的产品）。声明得早是因为 update() 会对它做
       * reconcile——文本顺序无所谓，运行时第一次 update 一定发生在装配完成之后。
       */
      let escalation = null
      /** 标题闪烁与桌面通知的工厂实例（装配在下面，ring() 运行时才用）。 */
      let titleFlash = null
      let desktop = null

      const snapshot = () => ({
        settings: { ...settings },
        audioState: player.state(),
        link: { ...link },
        mode: { ...mode },
        customs: customs.slice(),
        recent: recent.slice(0, 12),
      })
      const emit = () => { for (const fn of [...listeners]) { try { fn() } catch (error) { /* 单个订阅者坏了不影响别人 */ } } }
      const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }

      function update(patch) {
        settings = { ...settings, ...patch }
        writeSettings(settings)
        // 设置变了立刻与升级链对账：开关被关掉的活链马上取消，不等到触发瞬间
        if (escalation) escalation.reconcile()
        emit()
      }

      function record(entry) {
        recent.unshift({ time: Date.now(), ...entry })
        if (recent.length > 20) recent.length = 20
        emit()
      }

      // ── 自定义铃声：从宿主拉列表、上传、删除 ─────────────────────────────
      /**
       * 拉一次自定义铃声列表。
       * 失败不抛给界面：宿主可能是旧版本（没有这个口），那就当「没有自定义铃声」，
       * 内置四个音色照常用——功能缺席不该让整个设置页报错。
       */
      async function refreshCustoms() {
        try {
          const res = await fetch(`${API}/sounds/custom`, { cache: 'no-store' })
          if (!res.ok) return customs
          const data = await res.json()
          if (data && data.ok === true && Array.isArray(data.sounds)) {
            customs = data.sounds.map((entry) => ({
              name: String(entry.name || ''), file: String(entry.file || ''), bytes: Number(entry.bytes) || 0,
            })).filter((entry) => entry.name && entry.file)
            emit()
          }
        } catch (error) { /* 旧宿主或网络抖动：保持现状 */ }
        return customs
      }

      /**
       * 上传一个音频文件当铃声。
       * base64 走 JSON（而不是 multipart）：8 MiB 以内这点膨胀可以接受，换来的是
       * 宿主端不需要任何 body 解析依赖。
       */
      async function uploadCustom(file) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        // btoa 只吃 latin1；先按块转成二进制字符串，避免大文件把调用栈撑爆
        let binary = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
        }
        const res = await fetch(`${API}/sounds/custom`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: file.name,
            label: file.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''),
            dataBase64: window.btoa(binary),
          }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true) {
          throw new Error((data && data.error) || `HTTP ${res.status}`)
        }
        await refreshCustoms()
        return data
      }

      async function deleteCustom(name) {
        const res = await fetch(`${API}/sounds/custom?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true) {
          throw new Error((data && data.error) || `HTTP ${res.status}`)
        }
        // 删掉的音色如果正被选中，回退到内置音色，避免设置里留一个指向空气的名字
        const patch = soundPatchForDeleted(settings, name)
        if (Object.keys(patch).length > 0) update(patch)
        await refreshCustoms()
        return data
      }

      // 游标：只在同一台机器、同一个 DSH 进程内有意义；换成新进程时宿主 seq 重新从 1 开始，
      // 所以宁可把「比游标旧太久」的通知丢掉，也不要在启动瞬间补响一串旧铃（下面 STALE_MS 兜底）。
      let cursor = 0
      try { cursor = Number(window.localStorage.getItem(CURSOR_KEY) || 0) || 0 } catch (error) { cursor = 0 }

      function saveCursor(value) {
        cursor = value
        try { window.localStorage.setItem(CURSOR_KEY, String(value)) } catch (error) { /* 忽略 */ }
      }

      /**
       * 响一声。
       * @param kind 通知类别
       * @param detail 说明文字
       * @param gainScale 增益倍数（升级链用，默认 1）；与档位增益、滑杆音量相乘后 clamp 到 1.0
       * @param escalated 非空表示这是升级链的第 N 轮重响——只改记录文案，且不再嵌套武装新链
       */
      async function ring(kind, detail, gainScale = 1, escalated = 0) {
        const wanted = kind === 'complete'
          ? (settings.completeSound || 'complete')
          : (settings.assistSound || 'assist')
        const resolved = resolveSound(wanted)
        const prefix = escalated > 0 ? `升级提醒 第 ${escalated} 轮（音量 ×${gainScale}）` : ''
        if (inQuietHours(settings)) {
          record({ kind, ok: false, text: `${prefix}静音时段，跳过 ${resolved.hint}`, detail })
          return false
        }
        // 档位增益：完成音再乘 0.8（舒缓音不该吓人）；自定义音色按 1 算，滑杆仍是总音量；
        // 升级链的倍数叠在最外层，最终封顶 1.0（递增不能超过满音量）
        const gain = Math.min(1, resolved.gain * (Number(settings.volume) || 0) * gainScale)
        const played = await player.play(resolved.file, gain)
        record({
          kind,
          ok: played,
          text: prefix + (played ? '响了' : '被浏览器拦下（需要先点一下页面/解锁音频）') + '：' + resolved.hint,
          detail,
        })
        // 首响（非升级重响）之后武装升级链：没人理就按节奏追着重响
        if (!escalated && escalation) escalation.arm(kind, detail)
        if (settings.notifyTitle && titleFlash) titleFlash.flash(kind)
        // 桌面通知内部自己判开关与权限；不 await——权限弹窗可能一直挂着
        if (desktop) desktop.notify(kind, detail).catch(() => {})
      }

      // ── 标签页标题闪烁 ──────────────────────────────────────────────────
      /**
       * 标题闪烁的判断全部收进这个纯工厂（document 相关能力全部注入），
       * tests/notify.test.mjs 从本文件抽出它直接执行。
       *
       * 规则（TASK-notify-complete §2.1）：
       *  - 只在页面不可见时闪：人正盯着页面，别拿标题闪他；
       *  - 切回页面立刻恢复，不等兜底定时器；
       *  - 图标绝不累积：base 在首次闪烁时从当前标题**剥离自家前缀**得到，
       *    所以上一代插件留在标题里的图标也能被洗干净；
       *  - 闪烁期间带待看条数：`🔔(2) ` = 积了两条没看；
       *  - 6 s 兜底恢复仍保留（防止一直闪）。
       */
      function createTitleFlash(deps) {
        const PREFIX = /^(?:✅|🔔)(?:\(\d+\))?\s+/
        let base = null // 剥离前缀后的原标题；null = 当前没在闪
        let pending = 0
        let icon = '🔔'
        let timer = 0
        let dead = false

        function clearTimer() {
          if (timer) { deps.clearTimeout(timer); timer = 0 }
        }
        function apply() {
          const tag = pending > 1 ? `(${pending})` : ''
          deps.setTitle(`${icon}${tag} ${base}`)
        }
        function restore() {
          clearTimer()
          if (base !== null) deps.setTitle(base)
          base = null
          pending = 0
        }
        function flash(kind) {
          if (dead) return
          if (!deps.isHidden()) return // 页面可见时完全不碰标题
          if (base === null) base = String(deps.getTitle() || '').replace(PREFIX, '')
          pending += 1
          icon = kind === 'complete' ? '✅' : '🔔'
          apply()
          clearTimer()
          timer = deps.setTimeout(restore, 6000)
        }
        function onVisibilityChange(hidden) {
          if (dead) return
          if (!hidden) restore() // 切回页面立刻安静
        }
        function dispose() {
          if (dead) return
          dead = true
          restore()
        }
        return { flash, onVisibilityChange, dispose, active: () => base !== null }
      }

      // ── 桌面通知 ────────────────────────────────────────────────────────
      /**
       * 桌面通知的判断全部收进这个纯工厂（Notification / focus 全部注入），
       * tests/notify.test.mjs 从本文件抽出它直接执行。
       *
       * 规则（TASK-notify-complete §2.2）：
       *  - 点击通知 = 聚焦窗口 + 关掉这条通知；
       *  - 权限 default 不静默丢：先请求，拿到结果再决定发不发，结果回传给装配方刷新 UI；
       *  - 同类别同 tag：系统托盘里最多堆一条；第 N 条在标题里标注；
       *  - 任何失败都要落成一条用户可见的记录，不许 console 吞掉。
       */
      function createDesktopNotifier(deps) {
        const counts = new Map() // tag -> 已发条数（用于「第 N 条」标注）
        /**
         * 权限请求单飞（single-flight）：进行中的请求复用同一个 Promise。
         * 没有它的话，权限还是 default 时连到三条通知会各调一次 requestPermission()，
         * 而且后两条会立刻走进「未授予」分支各记一条误导性的失败记录——
         * 用户只是还没来得及点「允许」。
         */
        let inflight = null
        /** 拒绝提示一个周期只记一条：三条并发各记一条 = 刷屏。授予成功或新请求开始时复位。 */
        let deniedHinted = false

        function requestPermissionOnce() {
          if (!inflight) {
            deniedHinted = false // 新一轮请求：之后的拒绝值得再提一次
            inflight = Promise.resolve()
              .then(() => deps.requestPermission())
              .then((p) => p, () => 'denied')
              .then((p) => {
                inflight = null // 完成后清空：下一次 default 状态可以再请求
                if (deps.onPermission) deps.onPermission(p) // 回写设置页状态（一次就够）
                return p
              })
          }
          return inflight
        }

        function titleFor(kind, n) {
          const text = kind === 'complete' ? '活干完了' : '需要你协助'
          return n > 1 ? `${text}（第 ${n} 条）` : text
        }

        async function notify(kind, detail) {
          if (!deps.isEnabled()) return false
          const Ctor = deps.NotificationCtor
          if (typeof Ctor !== 'function') {
            deps.record({ kind, ok: false, text: '桌面通知失败：此浏览器不支持系统通知' })
            return false
          }
          let permission = deps.getPermission()
          if (permission === 'default') {
            permission = await requestPermissionOnce()
          }
          if (permission !== 'granted') {
            if (!deniedHinted) {
              deniedHinted = true
              deps.record({
                kind, ok: false,
                text: `桌面通知未弹出：系统权限是「${permission}」，请到浏览器设置里放开通知权限`,
              })
            }
            return false
          }
          deniedHinted = false
          const tag = 'dsh-chime-' + (kind === 'complete' ? 'complete' : 'assist')
          const n = (counts.get(tag) || 0) + 1
          counts.set(tag, n)
          try {
            const note = new Ctor(titleFor(kind, n), { body: detail || '', tag })
            if (note && typeof note === 'object') {
              note.onclick = () => {
                deps.focus()
                try { note.close() } catch (error) { /* 已关了就关了 */ }
              }
            }
            return true
          } catch (error) {
            deps.record({ kind, ok: false, text: '桌面通知失败：' + (error && error.message || error) })
            return false
          }
        }

        return { notify }
      }

      // ── 响过没人理就升级 ─────────────────────────────────────────────────
      /**
       * 调度与取消全部收进这个纯工厂：时间、定时器、可见性、设置、响铃全部依赖注入，
       * 自己不碰 window / document。tests/escalation-chain.test.mjs 从本文件里抽出
       * 它直接执行（同 decideBatch 的手法），用假时钟把取消/清理路径钉住——
       * 所以这里改逻辑，测试跟着变，不存在「测的是副本」的漂移。
       *
       * 不变量（都有测试钉着，改之前先看 tests/escalation-chain.test.mjs）：
       *  - 全程最多一条活链、一个 pending 定时器（重排前必清旧的）；
       *  - 关注（页面变可见 / 任意交互）即取消，取消后绝不再响；
       *  - 触发瞬间重查总开关、升级开关、静音时段；
       *  - dispose() 之后不留下任何会响的东西（§5.6 的教训）。
       */
      function createEscalation(deps) {
        let chain = null // { kind, detail, plan, index, timer, startedAt }

        function cancel(reason) {
          if (!chain) return false
          if (chain.timer) deps.clearTimeout(chain.timer)
          // 记一条「你刚回来」的痕迹：不然用户只会看到升级链莫名其妙不追了，没法确认它生效过。
          // kind 用 'escalation' 而不是复用 'merged'——后者是「批次合并」的类别，语义对不上。
          const dead = chain
          chain = null
          if (reason) deps.record({ kind: 'escalation', ok: true, text: reason, detail: dead.detail || '' })
          return true
        }

        function schedule() {
          // 重排前清旧定时器：哪怕旧 id 已经触发过（清死 id 是无害的 no-op），
          // 也要让「同时只有一个 pending」成为写死在代码里的不变量，而不是巧合
          if (chain.timer) deps.clearTimeout(chain.timer)
          const step = chain.plan[chain.index]
          const wait = Math.max(0, chain.startedAt + step.delayMs - deps.now())
          chain.timer = deps.setTimeout(fire, wait)
        }

        async function fire() {
          const current = chain
          if (!current) return
          // 触发瞬间再查一次开关：用户可能刚关掉总开关/升级开关，或进入了静音时段
          const s = deps.getSettings()
          if (!s.enabled || !s.escalateEnabled) { chain = null; return }
          if (deps.inQuietHours(s)) {
            chain = null
            deps.record({ kind: current.kind, ok: false, text: '进入静音时段，升级提醒就此打住', detail: current.detail })
            return
          }
          current.index += 1
          const step = current.plan[current.index - 1]
          await deps.ring(current.kind, current.detail, step.gainScale, current.index)
          // ring 可能武装了新链（escalated>0 时不会），只有还是原链才继续排下一轮
          if (chain === current) {
            if (current.index >= current.plan.length) chain = null
            else schedule()
          }
        }

        /** 首响之后武装升级链：新通知武装新链时旧链作废（用户只该被最新的事追着）。 */
        function arm(kind, detail) {
          cancel()
          // 注意：'test'（设置页那枚「让宿主发一条测试通知」）**故意**也走升级链——
          // 它是唯一能让人手动触发一次升级、当场验证这条功能好使的入口。
          const s = deps.getSettings()
          const plan = deps.buildPlan(kind, s.enabled && s.escalateEnabled, Number(s.escalateDelaySec) * 1000, 3)
          if (plan.length === 0) return false
          chain = { kind, detail, plan, index: 0, timer: 0, startedAt: deps.now() }
          schedule()
          return true
        }

        /** 「关注了」：页面变可见 / pointerdown / keydown 都汇到这一句。 */
        function attend() {
          if (chain) cancel('已注意到，升级提醒停止')
        }

        function onVisibilityChange(hidden) {
          if (!hidden) attend()
        }

        /** 设置变了之后对账：开关已关的活链立刻取消，不等到触发瞬间。 */
        function reconcile() {
          if (!chain) return
          const s = deps.getSettings()
          if (!s.enabled || !s.escalateEnabled) cancel()
        }

        return {
          arm, cancel, attend, onVisibilityChange, reconcile,
          /** 卸载清理：清定时器、链置空；事件监听的移除由装配方（ctx.effect 清理器）负责。 */
          dispose: () => { cancel() },
          /** 诊断/测试用：当前是否有活链。 */
          active: () => chain !== null,
        }
      }

      // 装配：把浏览器真实的时间/定时器/可见性/设置/响铃注进去。
      // buildEscalationPlan 在文件后段定义（function 声明有提升，这里直接用是安全的）。
      escalation = createEscalation({
        now: () => Date.now(),
        setTimeout: (fn, wait) => window.setTimeout(fn, wait),
        clearTimeout: (id) => window.clearTimeout(id),
        getSettings: () => settings,
        inQuietHours,
        buildPlan: buildEscalationPlan,
        ring: (kind, detail, gainScale, round) => ring(kind, detail, gainScale, round),
        record,
      })

      // 「关注了」的判据（任一即取消升级链）：页面变可见、真实交互（pointerdown/keydown）。
      // 设置页里的点击天然也是 pointerdown，不用单独埋点。
      ctx.effect(() => {
        const attended = () => escalation.attend()
        const onVisible = () => escalation.onVisibilityChange(document.hidden)
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('pointerdown', attended, { passive: true })
        window.addEventListener('keydown', attended)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('pointerdown', attended)
          window.removeEventListener('keydown', attended)
          escalation.dispose()
        }
      }, 'dsh-chime: escalation attention')

      // 装配：标题闪烁（document 能力注入；切回可见即恢复，卸载时 dispose）
      titleFlash = createTitleFlash({
        getTitle: () => document.title,
        setTitle: (value) => { document.title = value },
        isHidden: () => document.hidden,
        setTimeout: (fn, wait) => window.setTimeout(fn, wait),
        clearTimeout: (id) => window.clearTimeout(id),
      })
      ctx.effect(() => {
        const onVisible = () => titleFlash.onVisibilityChange(document.hidden)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          document.removeEventListener('visibilitychange', onVisible)
          titleFlash.dispose()
        }
      }, 'dsh-chime: title flash')

      // 装配：桌面通知（Notification 能力注入；权限结果回来就刷新设置页状态）
      desktop = createDesktopNotifier({
        NotificationCtor: typeof window.Notification === 'function' ? window.Notification : null,
        getPermission: () => (typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported'),
        requestPermission: () => window.Notification.requestPermission(),
        focus: () => window.focus(),
        isEnabled: () => settings.notifyDesktop,
        onPermission: () => emit(),
        record,
      })

      /** 音色清单：纯逻辑在模块级 soundOptionsOf（测试抽那份），这里只喂当前的 customs。 */
      function soundOptions() {
        return soundOptionsOf(customs)
      }

      /** 音色名 → 实际播放文件：纯逻辑在模块级 resolveSoundOf（测试抽那份）。 */
      function resolveSound(name) {
        return resolveSoundOf(name, customs)
      }

      let stopped = false
      /** 链路自检状态：让用户不用开控制台就能看出「宿主通没通」。 */
      let link = { ok: null, at: 0, error: '', pending: false, polls: 0 }
      const setLink = (patch) => { link = { ...link, ...patch }; emit() }

      async function poll() {
        if (stopped) return
        if (!settings.enabled) return
        try {
          const res = await fetch(`${API}/poll?since=${cursor}`, { cache: 'no-store' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const data = await res.json()
          if (!data || data.ok !== true) throw new Error('返回格式不对')
          setLink({ ok: true, at: Date.now(), error: '', polls: link.polls + 1 })
          const items = Array.isArray(data.items) ? data.items : []
          if (typeof data.lastSeq === 'number' && data.lastSeq > cursor) saveCursor(data.lastSeq)
          if (items.length > 0) await handleItems(items)
        } catch (error) {
          // 宿主还没起来 / 路由还没注册：静默重试，但把状态记下来给设置页看
          setLink({ ok: false, at: Date.now(), error: String(error && error.message || error) })
        }
      }

      /**
       * 决定这一批通知怎么响。纯函数，不碰播放器也不碰 DOM——
       * 测试（tests/batch.test.mjs）从本文件里抽出这段源码直接执行，
       * 所以这里改逻辑，测试跟着变，不存在「测的是副本」的漂移。
       *
       * 时间窗与优先级由调用方传入（闭包常量在抽出去的测试里不可见）。
       *
       * 规则：
       *  - 太老的（staleMs 外）直接丢且不响：宿主重启、断线回来不该补响一耳朵旧铃；
       *  - 一条刚发生的（freshMs 内）就单独响它——平时就是这个情况；
       *  - 一批一起到达（页面刚从后台回来、或一次塞了多条试听）：只挑**最急的**那条响一次
       *    （assist/alert > complete），其余报「已合并」。
       *    绝不静默丢：之前逐条循环 + 冷却会把后面几条吃掉，用户听到的表现就是「只有一种声音」。
       */
      function decideBatch(items, now, staleMs, freshMs, priority) {
        const age = (item) => now - Number(item.time || 0)
        const stale = items.filter((item) => age(item) > staleMs)
        const batch = items.filter((item) => age(item) <= staleMs && age(item) <= freshMs)
        if (batch.length === 0) return { play: null, merged: [], stale }
        // 比较器必须返回 -1/0/1：直接减时间戳会得到浮点差值，而排序只认符号，
        // 「0.8」等于 0 → 顺序退回数组顺序（真踩过：最新的那条反而没响）。
        // seq 兜底，保证同一毫秒入队的多条也有确定结果。
        const rank = (item) => [priority(item.kind), Number(item.time), Number(item.seq || 0)]
        const top = batch.slice().sort((a, b) => {
          const [pa, ta, sa] = rank(a)
          const [pb, tb, sb] = rank(b)
          if (pa !== pb) return pa < pb ? 1 : -1
          if (ta !== tb) return ta < tb ? 1 : -1
          if (sa !== sb) return sa < sb ? 1 : -1
          return 0
        })[0]
        return { play: top, merged: batch.filter((item) => item !== top), stale }
      }

      /**
       * 「响过没人理就升级」的升级计划。纯函数，与 decideBatch 一样会被测试
       * （tests/escalation.test.mjs）从本文件里抽出来直接执行——改它就等于改测试。
       *
       * 规则（来自需求，完整版见 HANDOFF §6）：
       *  - 只对「需协助」类（assist/alert/test——凡是走急促音色的）升级；完成音不追着人跑；
       *  - 首响后 firstDelayMs 没人理 → ×1.3 再响；再 +45 s → ×1.6；再 +45 s → ×1.9；
       *  - 最多 maxRepeats 次（默认 3，封顶 5），别无限轰炸；
       *  - 返回的 delayMs 都是相对首响时刻的绝对偏移，调用方按需换算成定时器等待。
       *
       * 音量上限不在这里算：增益倍数交给播放处与滑杆音量相乘后再 clamp 到 1.0。
       */
      function buildEscalationPlan(kind, enabled, firstDelayMs, maxRepeats) {
        if (!enabled) return []
        if (kind === 'complete' || kind === 'merged') return []
        const first = Math.max(5000, Math.min(600000, Number(firstDelayMs) || 30000))
        const count = Math.max(1, Math.min(5, Math.floor(Number(maxRepeats)) || 3))
        const plan = []
        for (let i = 0; i < count; i += 1) {
          plan.push({ delayMs: first + i * 45000, gainScale: Math.round((1 + 0.3 * (i + 1)) * 100) / 100 })
        }
        return plan
      }

      /**
       * 同一批通知只消费一次。
       *
       * 现在有两条来源（SSE 推送、轮询补拉）可能同时提到同一条通知，
       * 没有去重的话你会听到同一个铃响两遍。
       */
      const seen = new Set()
      function dedupe(items) {
        const fresh = []
        for (const item of items) {
          const key = Number(item.seq)
          if (!Number.isFinite(key) || seen.has(key)) continue
          seen.add(key)
          fresh.push(item)
        }
        // seen 只用来挡住"同一批被两条来源各送一次"，保留最近的 200 条足够
        if (seen.size > 200) {
          const keep = [...seen].sort((a, b) => a - b).slice(-100)
          seen.clear()
          for (const key of keep) seen.add(key)
        }
        return fresh
      }

      async function handleItems(rawItems) {
        const items = dedupe(rawItems)
        if (items.length === 0) return
        const { play, merged, stale } = decideBatch(items, Date.now(), STALE_MS, FRESH_MS, priorityOf)
        for (const item of stale) {
          record({ kind: item.kind, ok: false, text: '过期通知，忽略', detail: item.title })
        }
        if (play === null) return
        if (!player.ready()) {
          record({ kind: play.kind, ok: false, text: `冷却中，跳过 ${1 + merged.length} 条`, detail: play.title })
          return
        }
        player.markPlayed()
        await ring(play.kind, play.title || play.detail || '')
        if (merged.length > 0) {
          record({
            kind: 'merged',
            ok: false,
            text: `另有 ${merged.length} 条同时到达，已合并进这一声`,
            detail: merged.map((i) => i.title).join(' / '),
          })
        }
      }

      // ── 真·实时：SSE 长连接 ────────────────────────────────────────────────
      // 宿主一有通知就写下来，毫秒级到；后台标签页同样有效（不受定时器节流影响）。
      // 轮询保留，但只当兜底与「断线补拉」——见下面 source.onopen 里的补拉。
      const setMode = (patch) => { Object.assign(mode, patch); emit() }

      ctx.effect(() => {
        if (typeof window.EventSource !== 'function') return () => {}
        let source = null
        let closed = false
        const teardown = () => {
          closed = true
          if (source) { try { source.close() } catch (error) { /* 忽略 */ } source = null }
          setMode({ push: false })
        }
        try {
          source = new window.EventSource(`${API}/stream`)
        } catch (error) {
          setMode({ push: false })
          return () => { closed = true }
        }

        source.onopen = () => {
          if (closed) return
          setMode({ push: true })
          // 每次连上（含浏览器自动重连）都补拉一次：断线期间的通知靠这一步捞回来。
          // 推送本身会带上新通知，这里只是把缺口填上，/poll 是幂等的。
          poll()
        }
        source.onmessage = (event) => {
          if (closed) return
          let payload = null
          try { payload = JSON.parse(event.data) } catch (error) { return }
          if (!payload || payload.ok !== true) return
          setLink({ ok: true, at: Date.now(), error: '' })
          // 首帧：宿主告诉我们当前水位。比本地游标高就说明断线期间漏了，补拉一次。
          if (payload.hello === true) {
            setMode({ since: payload.lastSeq })
            if (Number(payload.lastSeq) > cursor) poll()
            return
          }
          if (payload.item) handleItems([payload.item])
        }
        source.onerror = () => {
          if (closed) return
          // 浏览器会按 retry 自动重连；这里只把状态显示出来，并让轮询接管兜底
          setMode({ push: false })
          setLink({ ok: false, at: Date.now(), error: '推送连接断开，已切回轮询兜底' })
        }
        return teardown
      }, 'dsh-chime: sse stream')

      // 兜底轮询：推送断了才靠它。可见时 20 s（原 2 s），隐藏时 45 s——
      // 实时性已经由 SSE 承担，这里只是别让通知永远卡在队列里。
      ctx.effect(() => {
        let handle = 0
        const tick = () => {
          const delay = document.hidden ? HIDDEN_POLL_MS : POLL_MS
          handle = window.setTimeout(() => { poll().finally(tick) }, delay)
        }
        tick()
        return () => { stopped = true; if (handle) window.clearTimeout(handle) }
      }, 'dsh-chime: poll loop')

      // 页面重新可见时立刻补一次：后台标签页的定时器会被浏览器节流，回来时不想到下一轮
      ctx.effect(() => {
        const onVisible = () => { if (!document.hidden) poll() }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
      }, 'dsh-chime: visibility poll')

      // 自动播放策略：AudioContext 在创建时多半是 suspended，任何一次真实交互都解开它
      ctx.effect(() => {
        const kick = () => { player.unlock().catch(() => {}) }
        window.addEventListener('pointerdown', kick, { passive: true })
        window.addEventListener('keydown', kick)
        return () => {
          window.removeEventListener('pointerdown', kick)
          window.removeEventListener('keydown', kick)
        }
      }, 'dsh-chime: audio unlock')

      ctx.effect(() => () => {
        stopped = true
        listeners.clear()
      }, 'dsh-chime: teardown')

      // 预热：进页面就把音频解码好，第一次响铃才没有解码延迟。
      // 先拉自定义铃声列表（它决定要预热哪些文件），再解锁 + 解码。
      ctx.effect(() => {
        let alive = true
        const run = async () => {
          // 别让一个不响应的宿主把设置页卡在「加载中」：拿不到就用内置音色继续
          try {
            await Promise.race([
              refreshCustoms(),
              new Promise((resolve) => window.setTimeout(resolve, 3000)),
            ])
          } catch (error) { /* 忽略 */ }
          if (!alive) return
          try {
            await player.unlock()
            await player.preload(soundOptions().map((option) => option.file))
          } catch (error) { /* 首次播放时还会再试 */ }
        }
        run()
        return () => { alive = false }
      }, 'dsh-chime: preload')

      if (typeof window.Notification === 'function' && settings.notifyDesktop && window.Notification.permission === 'default') {
        // 启动时补一次权限请求；结果回来后刷新设置页的权限状态显示
        try { window.Notification.requestPermission().then(() => emit()).catch(() => {}) } catch (error) { /* 忽略 */ }
      }
      poll()

      // ── 设置页 ────────────────────────────────────────────────────────────
      /**
       * 组件树工厂：React 与全部对外能力注入。tests/settings-smoke.test.mjs 从本文件
       * 抽出它，用极简 React stub + 假 deps 渲染整棵树——钉住「至少能渲染、不抛异常」，
       * 防止「改完自测看着没事，用户一打开设置页就白屏」。下面装配处传真实 React 与真实能力。
       */
      function createPanel(React, deps) {
        const h = React.createElement

      function useChime() {
        const [state, setState] = React.useState(() => deps.snapshot())
        React.useEffect(() => deps.subscribe(() => setState(deps.snapshot())), [])
        return state
      }

      function Row(props) {
        return h('div', { className: 'row' + (props.between ? ' between' : '') }, props.children)
      }

      function Switch(props) {
        return h('span', {
          className: 'switch' + (props.on ? ' on' : ''),
          role: 'switch',
          'aria-checked': props.on ? 'true' : 'false',
          title: props.title || '',
          onClick: () => props.onChange(!props.on),
        })
      }

      function SoundPicker(props) {
        return h('select', {
          value: props.value,
          onChange: (e) => {
            props.onChange(e.target.value)
            // 试听按真实档位增益放，用户听到的就是以后响的那个音量
            deps.player.play(...(() => { const r = deps.resolveSound(e.target.value); return [r.file, deps.snapshot().settings.volume * r.gain] })())
          },
        }, deps.soundOptions().map((option) => h('option', { key: option.name, value: option.name },
          `${option.label}（${option.hint}）`)))
      }

      function ChimePanel() {
        const state = useChime()
        const s = state.settings
        const [diagText, setDiagText] = React.useState('')
        const diag = (value) => setDiagText(value)
        // 自定义铃声的本地 UI 状态：上传中、以及一句给用户看的结果说明
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState('')
        const fileRef = React.useRef(null)
        const audioOk = state.audioState === 'running'
        // 桌面通知的系统权限状态：直接读浏览器当前值（每次渲染都是新的）
        const perm = deps.getNotificationPermission()
        const permText = perm === 'granted' ? '已授予'
          : perm === 'denied' ? '已拒绝'
            : perm === 'unsupported' ? '此浏览器不支持'
              : '未请求'
        const l = state.link
        const pushOn = state.mode.push
        const linkLine = pushOn
          ? `实时推送已连接`
          : l.ok === true
            ? `推送未连接，走轮询兜底（已轮询 ${l.polls} 次）`
            : l.ok === false
              ? `连不上宿主：${l.error}`
              : '正在自检…'
        const [, force] = React.useState(0)
        const refresh = () => force((n) => n + 1)

        return h('div', { className: 'chime-panel' },
          h(Row, { between: true },
            h('div', null,
              h('div', { style: { fontWeight: 600 } }, '响铃提醒'),
              h('div', { className: 'hint' }, '后台干完活响一声舒缓的，需要你出面时响急促的。'),
            ),
            h(Switch, { on: s.enabled, title: '总开关', onChange: (v) => { deps.update({ enabled: v }); if (v) deps.poll() } }),
          ),

          !s.enabled ? h('div', { className: 'hint' }, '已关闭：不会响铃，也不会留下记录。') : null,

          // 「怎么用」速查：用原生 <details> 而不是 React state——不引入新的 hooks，
          // 冒烟测试里的 stub 也能照常递归到里面的文案（内容都在 children，不在 props）。
          h('details', { className: 'chime-help' },
            h('summary', null,
              h('span', { className: 'help-title' }, '怎么用（点开看）'),
              h('span', { className: 'hint' }, '什么时候响 · 常用操作 · 出问题看哪'),
            ),
            h('div', { className: 'help-body' }, buildHelpNodes(h)),
          ),

          h('div', { className: 'section-title' }, '音频状态'),
          h('div', { className: 'card' },
            h(Row, { between: true },
              h('span', { className: 'badge ' + (audioOk ? 'ok' : 'warn') },
                audioOk ? '已解锁，可以响' : '未解锁（浏览器要求先有一次交互）'),
              h(Row, null,
                h('button', { className: 'btn-primary', onClick: async () => { await deps.player.unlock(); await deps.player.preload(Object.keys(SOUNDS).map((k) => SOUNDS[k].file)); refresh() } }, '解锁并加载'),
                h('button', { onClick: async () => { await deps.player.unlock(); await deps.player.play('blip', s.volume * GAIN.blip); refresh() } }, '响一声'),
              ),
            ),
            h(Row, { between: true },
              h('span', { className: 'badge ' + (pushOn || l.ok === true ? 'ok' : l.ok === false ? 'warn' : '') }, linkLine),
              h('span', { className: 'hint' }, l.at ? new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''),
            ),
            h('div', { className: 'hint' }, '浏览器规定：页面在收到一次点击/按键前不允许自动播放声音。点一下「解锁并加载」就够了，刷新页面后会自动恢复（本机浏览器通常已记住）。'),
            h('div', { className: 'hint' }, pushOn
              ? '传输方式：SSE 实时推送（长连接）——宿主一有通知立刻到，后台标签页也照样响，不受浏览器定时器节流影响。'
              : '传输方式：轮询兜底（推送未连上时自动接管）。'),
          ),

          h('div', { className: 'section-title' }, '音量与音色'),
          h('div', { className: 'card' },
            h(Row, null,
              h('span', { style: { width: 48 } }, '音量'),
              h('input', {
                type: 'range', min: 0, max: 100, value: Math.round(s.volume * 100),
                onChange: (e) => deps.update({ volume: Number(e.target.value) / 100 }),
                onMouseUp: () => deps.player.play(s.completeSound, s.volume * (GAIN[s.completeSound] || 1)),
              }),
              h('span', { className: 'hint', style: { width: 34, textAlign: 'right' } }, Math.round(s.volume * 100) + '%'),
            ),
            h('div', { className: 'hint' }, '这是总音量；「完成时」的铃声会再轻 20%（舒缓音不该吓人），「需协助时」用满音量——两条都按同一个滑杆缩放。'),
            h(Row, null,
              h('span', { style: { width: 76 } }, '完成时'),
              h(SoundPicker, { value: s.completeSound, onChange: (v) => deps.update({ completeSound: v }) }),
            ),
            h(Row, null,
              h('span', { style: { width: 76 } }, '需协助时'),
              h(SoundPicker, { value: s.assistSound, onChange: (v) => deps.update({ assistSound: v }) }),
            ),
            h(Row, null,
              h('span', { style: { width: 76 } }, '静音时段'),
              h('input', { type: 'text', value: s.quietFrom, placeholder: '23:00', onChange: (e) => deps.update({ quietFrom: e.target.value }) }),
              h('span', { className: 'hint' }, '至'),
              h('input', { type: 'text', value: s.quietTo, placeholder: '07:00', onChange: (e) => deps.update({ quietTo: e.target.value }) }),
              h('span', { className: 'hint' }, '（留空 = 全天都响；支持跨零点）'),
            ),
          ),

          h('div', { className: 'section-title' }, '自定义铃声'),
          h('div', { className: 'card' },
            h(Row, { between: true },
              h('span', null, `我的铃声（${state.customs.length}）`),
              h('button', { onClick: () => fileRef.current && fileRef.current.click() }, busy ? '上传中…' : '上传音频文件'),
            ),
            state.customs.length > 0
              ? h('div', { className: 'log' }, state.customs.map((entry) => h(Row, { key: entry.name, between: true },
                h('span', null, `${entry.name}（${Math.round((entry.bytes || 0) / 1024)} KB）`),
                h('button', {
                  disabled: busy,
                  onClick: () => {
                    if (busy) return
                    setBusy(true)
                    setNotice('')
                    deps.deleteCustom(entry.name)
                      .then(() => setNotice(`已删除「${entry.name}」`))
                      .catch((error) => setNotice('删除失败：' + (error && error.message || error)))
                      .finally(() => setBusy(false))
                  },
                }, '删除'),
              )))
              : null,
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: 'audio/*,.wav,.mp3,.ogg,.m4a,.flac,.webm',
              style: { display: 'none' },
              onChange: async (e) => {
                const file = e.target.files && e.target.files[0]
                e.target.value = ''
                if (!file) return
                setBusy(true)
                setNotice('正在上传 ' + file.name + '…')
                try {
                  const saved = await deps.uploadCustom(file)
                  setNotice(`已保存「${saved.name}」（${Math.round((saved.bytes || 0) / 1024)} KB），可以在上面「完成时 / 需协助时」里选它`)
                } catch (error) {
                  setNotice('上传失败：' + (error && error.message || error))
                }
                setBusy(false)
              },
            }),
            h('div', { className: 'hint' }, busy ? '处理中…' : (notice || '支持 wav / mp3 / ogg / m4a / flac / webm，单个不超过 8 MiB。文件存在 DSH_HOME\\dsh-chime\\sounds\\，重装插件也不会丢。')),
          ),

          h('div', { className: 'section-title' }, '提醒方式'),
          h('div', { className: 'card' },
            h(Row, { between: true },
              h('span', null, '标签页标题闪烁'),
              h(Switch, { on: s.notifyTitle, onChange: (v) => deps.update({ notifyTitle: v }) }),
            ),
            h(Row, { between: true },
              h('span', null, '桌面通知（系统弹窗）'),
              h(Row, null,
                h('span', {
                  className: 'badge ' + (perm === 'granted' ? 'ok' : perm === 'default' ? '' : 'warn'),
                }, permText),
                h(Switch, {
                  on: s.notifyDesktop,
                  onChange: (v) => {
                    if (v && deps.getNotificationPermission() !== 'granted' && deps.requestNotificationPermission) {
                      deps.requestNotificationPermission().then(() => deps.emit()).catch(() => {})
                    }
                    deps.update({ notifyDesktop: v })
                  },
                }),
              ),
            ),
            s.notifyDesktop && perm === 'denied'
              ? h('div', { className: 'hint' }, '开关开着，但浏览器已拒绝通知权限，弹窗不会出来。请到浏览器设置（地址栏左侧锁形图标 → 网站权限 → 通知）里放开后刷新页面。')
              : null,
            s.notifyDesktop && perm === 'unsupported'
              ? h('div', { className: 'hint' }, '此浏览器不支持系统通知，这个开关不会生效。')
              : null,
          ),

          h('div', { className: 'section-title' }, '没人理就升级'),
          h('div', { className: 'card' },
            h(Row, { between: true },
              h('span', null, '响过没人理就升级'),
              h(Switch, {
                on: s.escalateEnabled,
                title: '只对「需协助」类提醒生效，完成音不追着人跑',
                onChange: (v) => { deps.update({ escalateEnabled: v }) },
              }),
            ),
            h(Row, null,
              h('span', { style: { width: 76 } }, '首次延迟'),
              h('input', {
                type: 'text',
                value: String(s.escalateDelaySec),
                placeholder: '30',
                onChange: (e) => deps.update({ escalateDelaySec: e.target.value }),
              }),
              h('span', { className: 'hint' }, '秒（5–600，默认 30）'),
            ),
            h('div', { className: 'hint' },
              '「需协助」响铃后没人回来（页面仍不可见、也没有任何点击/按键），就按首次延迟 / +45 秒 / +45 秒的节奏最多再响 3 次，音量逐次 ×1.3 / ×1.6 / ×1.9（最高不超过满音量）。你一回到页面或有任何操作就立刻停止；静音时段与总开关同样生效。'),
          ),

          h('div', { className: 'section-title' }, '最近的通知'),
          h('div', { className: 'card' },
            state.recent.length === 0
              ? h('div', { className: 'hint' }, '还没有通知。')
              : h('div', { className: 'log' }, state.recent.map((item, index) => h('div', { className: 'line', key: index },
                h('span', { className: 't' }, new Date(item.time).toLocaleTimeString('zh-CN', { hour12: false })),
                h('span', null, (item.ok === false ? '· ' : '· ') + item.text + (item.detail ? ' — ' + item.detail : '')),
              ))),
            h(Row, null,
              h('button', { onClick: () => { fetch(`${API}/test?kind=${encodeURIComponent(s.completeSound)}`).catch(() => {}) } }, '让宿主发一条测试通知'),
              h('button', {
                onClick: async () => {
                  try {
                    const res = await fetch(`${API}/status`, { cache: 'no-store' })
                    const data = await res.json()
                    diag(JSON.stringify(data, null, 1))
                  } catch (error) { diag('诊断读取失败：' + (error && error.message || error)) }
                },
              }, '看诊断信息'),
              h('span', { className: 'hint' }, '（走完整链路：宿主入队 → 网页轮询 → 响铃）'),
            ),
            diagText === '' ? null : h('pre', {
              style: {
                margin: 0, maxHeight: 200, overflow: 'auto', fontSize: 11, lineHeight: 1.5,
                background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap',
              },
            }, diagText),
          ),

          h('div', { className: 'hint' },
            '规则：主会话「这一轮正常干完」→ 舒缓音；agent 提问 / 计划待批准 / 卡住或出错 → 急促音。',
            h('br'),
            '子 agent 的会话默认不单独响铃（主会话收口时会一并结束）；宿主端可用 config.notifySubagentSessions 打开。',
          ),
        )
      }

        return { ChimePanel, h }
      }

      // 装配：真实 React + 真实能力注入组件树工厂
      const { ChimePanel, h } = createPanel(React, {
        snapshot, subscribe, update, poll, player, uploadCustom, deleteCustom,
        resolveSound, soundOptions, emit,
        getNotificationPermission: () => (typeof window.Notification === 'function' ? (window.Notification.permission || 'default') : 'unsupported'),
        requestNotificationPermission: () => window.Notification.requestPermission(),
      })

      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'chime', order: 26, label: '响铃' },
        () => h(ChimePanel),
      ))
    }

    const inject = ['slots']
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
