# dsh-chime 交接文档

> 给接手这个项目的 Agent（或未来的自己）。读完这一份应该就能动手改，不用再把整个会话读一遍。
>
> 最后更新：2026-10-11 ｜ 状态：**七项全部完成；只剩 2 项低优先可选项（见下方进度块）。测试 105 项全绿**

---

## 0. 一句话现状

`dsh-chime` 是一个可安装在 DSH profile 中运行的插件：后台 agent 干完活响一声舒缓铃、需要用户出面时响急促铃。宿主端判定 + 浏览器端播放，支持实时推送与自定义铃声。

```
已完成  ①真·实时（SSE 推送，实测延迟 1 ms）
已完成  ②自定义铃声（上传 / 选择 / 删除）
已完成  ③响过没人理就升级（30 s 起、+45 s 节奏、×1.3/×1.6/×1.9、最多 3 次；纯客户端实现）
已完成  ④升级链「取消 / 清理」测试（16 条，验收方变异测试 5/5 被杀）
已完成  ⑤标签页标题闪烁 + 桌面通知补完（16 条，验收方变异测试 5/5 被杀）
已完成  ⑥权限请求「单飞」+ 拒绝提示去重（3 条；验收方变异测试 3/3 被杀，实现见 TASK-notify-complete.md 附录 A2）
已完成  ⑦设置页冒烟测试（18 条：纯逻辑 12 + React stub UI 冒烟 6，抓崩验证通过）

⬜ 可选  ⑧链状态挪到宿主端（跨刷新 / 多设备去重）——除非真遇到，否则别动
⬜ 可选  ⑨自定义铃声删除改列表式（README 补体积/格式清单那半，已顺手做了）
```

> 详细验收与测试说明见同目录下的 `TASK-*.md`。

> 第 3 项实现要点（2026-10-11）：**全程在 `lib/client.js`**（升级是「播放与关注」逻辑，宿主无需改，**不用重启 DSHA**，硬刷新页面即可）。纯函数 `buildEscalationPlan(kind, enabled, firstDelayMs, maxRepeats)` 被 `tests/escalation.test.mjs` 抽出钉住；升级链挂在 `ctx.effect` 里，关注判据 = 页面变可见 / pointerdown / keydown。增益倍数在播放处与滑杆相乘后 clamp 到 1.0。顺手完成两项低优先级：删除改列表式、README 已知边界补 8 MiB 与格式清单。

---

## 1. 三条铁律（不遵守会浪费大量时间）

### 1.1 改了 `lib/index.js` → **必须重启 DSHA 桌面应用**

宿主端代码是 link 安装的，**DSH 的 HMR 不监视 link 插件的源码目录**。已验证无效的手段（别再试）：

- `touch` 文件改 mtime
- 用 `plugin_manager` 切 `set_plugin` / `set_bundle` 开关
- 改包内 `cordis.patch.yml`

**有效且唯一**：彻底退出 DSHA → 重新打开。重启会中断当前会话（正在跑的 agent 会断），所以改宿主代码前先想清楚，攒够改动一次重启。

### 1.2 改了 `lib/client.js` → **页面必须 Ctrl+Shift+R 硬刷新**

浏览器半边由 DSH 的客户端模块系统下发（它有 HMR，但 link 插件的变更不保证被推送）。普通 F5 可能吃缓存，硬刷新最稳。

### 1.3 不要手改 profile 配置，不要在 profile 目录裸跑 pnpm

- 正确姿势：`plugin_manager` 工具的 `install_bundle`（官方推荐），或 `dsh plugin --profile desktop add <spec>`（需先完全退出桌面应用）。
- 安装依赖时遵循宿主和包管理器配置的供应链安全策略；不要为了绕过校验而关闭安全限制。
- 修改 DSH profile 前，先备份其 `package.json` 与 lockfile。

---

## 2. 代码地图

仓库根：`.`

| 文件 | 行数 | 职责 |
|---|---:|---|
| `lib/rules.js` | 71 | **纯函数判定**：`decide(event)` → 这条会话事件值不值得响铃、响哪一档。改「什么情况该响」只动这里 |
| `lib/index.js` | 525 | 宿主半边：监听 `session/event`、通知队列、SSE 推流、HTTP 路由、自定义铃声的落盘管理 |
| `lib/client.js` | 785 | 浏览器半边（手写 bundle，**不经打包**）：SSE 订阅 / 轮询兜底、批次决策、Web Audio 播放、设置页 UI |
| `sounds/*.wav` | — | 四首内置铃声（`complete` / `assist` / `alert` / `blip`） |
| `sounds/synth_sounds.py` | — | 铃声合成器（numpy 加法合成，无音频库依赖）。改音色改这里再重跑 |
| `sounds/check_sounds.py` | — | 读回 WAV 打印包络与音高，确认乐句真的成型 |
| `sounds/make_preview.py` | — | 生成 `preview.html`（音频 base64 内嵌，双击即可试听，用于隔离「文件/音箱」问题） |
| `tests/*.mjs` | — | 见下节 |
| `README.md` | — | 面向用户的功能说明；本文件面向接手者 |

### 关键数据结构

```js
// 通知（宿主队列 → 浏览器）
{ seq, time, kind, title, detail, sound, sessionId, agentPreset }
// kind: 'complete' | 'assist' | 'test' | 'merged'
```

### HTTP 路由（全部在 `/dsh-chime` 命名空间内，不碰宿主其它路由）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/stream` | **SSE 长连接**：首帧 `hello`（带水位），之后每条通知即推；25 s 注释心跳 |
| GET | `/poll?since=<seq>` | 增量拉取（兜底 + 断线补拉） |
| GET | `/sounds/custom` | 列出自定义铃声 |
| POST | `/sounds/custom` | 上传（JSON + base64） |
| DELETE | `/sounds/custom?name=<n>` | 删除 |
| GET | `/sounds/<name>` | 取铃声文件（内置白名单 + 扫描出的自定义文件） |
| GET | `/test?kind=<n>` | 自塞一条测试通知，走完整链路 |
| GET | `/status` | 诊断口（见 §3） |

**注意**：前三条 `exact` 路由 + 一条 `prefix /dsh-chime` 兜底；prefix 的尾斜杠会让 Web 服务器永远匹配不上，**注册 prefix 路由绝不能带尾斜杠**（代码里有自动剥除，也有测试钉住）。

---

## 3. 怎么验证（先看这里，别凭猜）

```powershell
# run:all-tests
cd <plugin-directory>
npm test

# run:verify-audio
npm run verify:audio

# run:status
curl "http://127.0.0.1:19387/dsh-chime/status"

# run:test-notify
curl "http://127.0.0.1:19387/dsh-chime/test?kind=assist"
```

`/status` 返回里最有用的是：

- `streamClients`：有几个页面挂着 SSE 长连接（**1 = 用户页面在线**，0 = 页面关了或没刷新）
- `stats.classified`：按 `turn/end:<reason>`、`tool/call:<name>` 分类的**真实事件计数**——能证明插件真在监听，而不是装上了没动静
- `queue`：还没被页面取走的通知数（一直不降 = 页面没在消费）
- `customSounds` / `customDir`：自定义铃声数量与目录

> **`customSounds` 可能是个陈旧值**：它来自插件启动时的那次目录扫描，之后只有「上传 / 删除 / 列表请求」才会重扫。所以如果你**在插件运行期间手动删了那个目录**，`/status` 仍会报旧数字，重启或发一次 `GET /sounds/custom` 才刷新。别把这种不一致当成 bug 去查（本项目交接时就遇到过：目录已空、`/status` 还报 5）。

### 测试文件分工

| 文件 | 项数 | 覆盖 |
|---|---:|---|
| `rules.test.mjs` | 8 | 判定表：什么该响、什么不该响（含 `aborted` 不响这种反直觉项） |
| `host.test.mjs` | 15 | 宿主端：路由形状、队列增量、去重、子会话策略、SSE 帧、断开回收、诊断口 |
| `batch.test.mjs` | 9 | 批次决策。**从 `lib/client.js` 源码里抽出 `decideBatch` 直接执行**，测的就是线上那份逻辑 |
| `sse-http.test.mjs` | 3 | 真实 `http` 服务器 + 真实 `fetch` 读 SSE 流，量推送延迟、验证长连接不泄漏 |
| `custom-sound.test.mjs` | 6 | 自定义铃声上传/列表/删除/格式嗅探/路径穿越/隔离 |
| `escalation.test.mjs` | 8 | 升级**计划**纯函数：节奏/倍数/上限/非法输入（从 `client.js` 抽出执行） |
| `escalation-chain.test.mjs` | 16 | 升级链**调度与取消**：假时钟+假定时器，定时器不累积、四种取消路径、dispose 清理、静音/开关触发瞬间重查（从 `client.js` 抽出 `createEscalation` 执行） |
| `notify.test.mjs` | 19 | 标题闪烁 + 桌面通知：不可见才闪/切回即恢复/前缀剥离/待看条数；权限三分支/点击聚焦/同 tag 合并/失败记录/**权限请求单飞**（从 `client.js` 抽出 `createTitleFlash` / `createDesktopNotifier` 执行） |
| `settings-smoke.test.mjs` | 18 | 设置页：纯逻辑 12（静音时段/音色解析/设置读写收敛/清单合并/删除回退）+ UI 冒烟 6（极简 React stub 渲染 `createPanel` 整树，覆盖不到的见文件头诚实清单） |

**测试隔离约定（重要）**：`custom-sound.test.mjs` 会改 `process.env.DSH_HOME` 指向临时目录，且**每次请求前都重新钉一次**（`h.pin()`）。插件那头必须**惰性解析** `DSH_HOME`——曾经写成模块级常量，结果测试往用户真实 `~/.dsh` 里写了文件（已修，已清理）。**写新测试时别破坏这个隔离。**

---

## 4. 设计决策（都是有理由的，改之前先读）

### 4.1 判定规则：宁可少响，不可乱响

一次误报（比如子 agent 干活也响）就会让用户三天内关掉插件。所以：

| 时机 | 判据 | 铃声 |
|---|---|---|
| 干完了 | `turn/end` 且 `reason.kind === 'completed'` | 舒缓 |
| 问你问题 | `tool/call` 名字 = `ask_user_question` | 急促 |
| 计划待批 | `tool/call` 名字 = `exit_plan_mode` | 急促 |
| 卡住了 / 出错 | `turn/end` 的 `blocked` / `error` | 急促 |
| 用户自己按停 / 被中断 / 超长 / fork | `aborted` / `interrupted` / `max-tokens` / `forked` | **不响** |
| 子 agent 会话 | `header.parentSession` 或 `origin === 'subagent'` | **默认不响**（宿主 config 可开） |

两条降噪规则：**同一轮里问过就不再补一次**（否则提问 + 收尾会连环响）；**子 agent 默认不响**。

### 4.2 为什么宿主当裁判、浏览器放声音

宿主在 DSH 主进程内，能看到**全部**会话（包括没打开的会话、子 agent）；浏览器只看得见自己打开的那一个。而声音必须由用户坐着的浏览器发。所以：宿主判定 → 推给浏览器 → 浏览器播。

### 4.3 两段延迟要分开看

| 段 | 机制 | 实测 |
|---|---|---|
| agent 干活 → 宿主判定 | `ctx.on('session/event')`，事件驱动 | < 1 ms |
| 宿主判定 → 浏览器响铃 | SSE 长连接 | **1 ms**（`sse-http.test.mjs` 打印出来） |

改造前第二段是 2 s 轮询，且**后台标签页会被浏览器节流到分钟级**。轮询没有删：它是 20 s 一轮的兜底 + 断线补拉（每次 SSE 连上/重连都拿本地游标补一次 `/poll`）。

### 4.4 音量档位

滑杆是总音量；**完成音再 ×0.8**（舒缓音不该吓人），需协助用满音量，自定义音色按 1.0（用户自己的文件不该被再削一刀）。

### 4.5 自定义铃声存 `$DSH_HOME\dsh-chime\sounds\`

不放插件目录：那里是 git 仓库，塞二进制会脏；而且这样重装/升级/删掉重拉，用户的铃声都还在。文件名强收敛（只留字母数字与 `-` `_`），**请求里的路径永不参与拼接**；格式先看后缀、认不出看文件头（RIFF/OggS/fLaC/ID3/frame-sync/ftyp/EBML）。

---

## 5. 踩过的坑（别再踩）

1. **prefix 路由带尾斜杠** → 该前缀下所有请求 404（Web 服务器比的是 `${prefix}/`）。铃声 404 就是这么来的。
2. **客户端 bundle 的 `__ModuleLoader__.load({ id })` 必须是包名**（`dsh-chime`），不是 patch 里的行 id。写错 → `loaded without registering`，整条客户端行不挂载。
3. **一批通知一起到达时逐条播放 + 冷却 = 静默吃掉后面几条**（游标还推进了，等于永久丢失）。用户看到的现象是「只响了一声」。现在只挑**最急的一条**响，其余记「已合并」。
4. **排序比较器不能直接相减**：浮点差值被判成「相等」，顺序退回数组顺序（最新的那条反而没响）。必须返回 `-1/0/1`，并用 seq 兜底。
5. **SSE 写帧要对着订阅记录**，不是客户端 id：`sseSend(id, payload)` 里写 `id.socket`（id 是字符串）→ `undefined.write` → 每帧失败、连接被立刻断开。**假 req/res 的测试抓不到它**（假对象的 write 永远"成功"），所以才有了真 HTTP 的 `sse-http.test.mjs`。
6. **SSE 心跳的 `setInterval` 要把长连接收干净**（卸载时 end 掉已连上的 socket，否则热重载后旧页面挂在没人写的连接上）；同时它还会**把 Node 测试进程挂住**——`host.test.mjs` 结束时统一跑所有 `ctx.effect` 清理器。
7. **`CUSTOM_DIR` 惰性求值**（见 §3 的隔离约定）。
8. **假对象测不出协议问题**：能用真 HTTP 就用真 HTTP。

---

## 6. 第 3 项「响过没人理就升级」（已完成，以下为原始需求存档）

### 需求（用户原话）

> 响过没人理就升级

### 建议实现

- **触发**：只对**需要协助**这类通知（`assist`）升级；「完成」提示不追着人跑。
- **节奏**：首响后 30 s 用户仍未关注 → 音量递增（如 ×1.0 → ×1.3）再响一次；仍未关注 → 再等 45 s、×1.6……上限 3 次，别无限轰炸。
- **「关注了」的判据**（任一即取消升级链）：
  - `document.visibilitychange` 且页面变为可见；
  - 用户有真实交互（`pointerdown` / `keydown`）；
  - 用户在设置页里点过任意按钮。
- **必须尊重的开关**：总开关、静音时段（`inQuietHours`）、音量滑杆上限（递增后不要超过 1.0，可以在 UI 上说明「最高到滑杆音量」）。
- **可配置**：设置页加一个「响过没人理就升级」开关 + 首次延迟（默认 30 s）。
- **别用 `setInterval` 裸跑**：整条升级链要挂在 `ctx.effect` 里，插件卸载/热更新时必须清掉（参考 §5.6 的教训）。

### 配套任务单

- [TASK-escalation-tests.md](TASK-escalation-tests.md) —— **已完成**：升级链「取消 / 清理」路径测试（16 条；验收方变异测试 5/5 被杀）。
- [TASK-notify-complete.md](TASK-notify-complete.md) —— **全部完成**：主体 16 条（标题闪烁 + 桌面通知；验收方变异测试 5/5 被杀）＋ 附录 A2 追加 3 条（权限请求单飞、拒绝提示去重；验收方变异测试 3/3 被杀）。合计 19 条，见文末 A1/A2。
- [TASK-settings-smoke.md](TASK-settings-smoke.md) —— **已完成**：纯逻辑 12 条（`inQuietHours` / `resolveSoundOf` / `readSettingsFrom`（含 volume 收敛与未知字段忽略）/ `soundOptionsOf` / `soundPatchForDeleted` 抽成模块级纯函数）+ UI 冒烟 6 条（组件树就地包成 `createPanel(React, deps)`，极简 React stub 渲染整树；覆盖不到什么见测试文件头的诚实清单）。

> 执行顺序：先做 `TASK-notify-complete.md` 的 **附录 A2**（3 条用例，改动小、在自己文件里），再做 `TASK-settings-smoke.md`（18 条）。两者都要改 `lib/client.js`，**同一时间只动一处**、各自跑一遍全量测试，别叠在一起改。

### 顺手可做（用户之前提过、优先级低）

- 删除按钮改成列表式（目前是下拉里的「删除…」）
- `README.md` 里那张「已知边界」表可补充自定义铃声的体积上限与格式清单

---

## 7. 环境要求

| 项 | 建议 |
|---|---|
| DSH profile | 使用目标环境中的 profile，并通过官方插件管理器安装 |
| Node.js | `>=22.13.0` |
| Python | 运行音频脚本时需安装 `numpy` |
| 浏览器 | 支持 Web Audio 的 Chromium 系浏览器 |
| 自定义铃声目录 | `$DSH_HOME\dsh-chime\sounds` |

## 8. 改动前自检（每次收尾都跑）

```powershell
cd <plugin-directory>
npm test                                  # 105 项必须全绿
node --check lib\index.js                 # 宿主端语法
node --check lib\client.js                # 浏览器端语法
npm run verify:audio                      # 动了音频/播放逻辑才需要
curl http://127.0.0.1:19387/dsh-chime/status   # 重启后确认真的活着（看 streamClients）
```

改动涉及判定规则时，**先改 `lib/rules.js` 与 `rules.test.mjs`**，让规则在测试里定下来，再接线到宿主；涉及批次/播放时改 `lib/client.js` 的 `decideBatch`（它的测试会从源码里抽出来跑）。
