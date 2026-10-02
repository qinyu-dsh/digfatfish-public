# DSH 自愈看门狗（Watchdog + 快照 + 自动回滚）

> 交付日期：2026-08-18。背景：at-file/genui 安装后崩溃事故 + agent 预设被 patch 误禁用的教训。
> 目标：**插件变更前自动留快照；变更导致服务崩溃时，自动回滚到最近健康版本并重启。**

## 一、三个角色

| 角色 | 文件 | 干什么 |
|---|---|---|
| 看门狗 | `watchdog-dsh.ps1` | 每 2 分钟跑一次（计划任务 `DSH Watchdog`）：健康检查 + 变更检测 + 崩溃触发回滚 |
| 快照 | `dsh-snapshot.ps1` | `-Take`（备份三件套）/ `-List`（列出，`[H]`=健康锚点）/ `-MarkHealthy` |
| 回滚 | `dsh-rollback.ps1` | `-Snapshot <名>` / `-Auto`：保留坏现场 → 恢复三件套 → pnpm install → 探针 → 安全重启 |

公共逻辑在 `watchdog-common.ps1`；状态在 `watchdog-state.json`；事件日志 `watchdog.log`（同目录）。

快照存于 `D:\dhs01\dsh-profile-backup\snapshots\<名字>\`（三件套 + manifest.json）。
三件套 = `$HOME\.dsh\profiles\web\` 下的 `package.json` + `cordis.patch.yml` + `pnpm-workspace.yaml`。

## 二、状态机（看门狗每一轮）

```
1. 计算三件套 hash
2. hash ≠ 记录值？  → 自动快照 auto-<时间>，状态置 pending（服务未动，旧树继续跑）
3. 健康检查（3080 监听 + HTTP 200）
   ├─ 健康：
   │    ├─ pending 且服务 pid 变了（确实重启过）→ 新快照标记 [H]（成为回滚锚点）
   │    └─ pending 但没重启 → 保持观察（未生效的配置绝不标健康）
   └─ 不健康：连续 2 次失败 →
        ├─ 有 [H] 锚点 → 自动回滚（rollback 全流程）→ 验证 HTTP 200
        └─ 无锚点 / 刚失败过（10 分钟抑制期）→ 只记录，不动手
```

关键安全设计：
- **探针先行**：回滚后先 `restart-dsh.ps1 -ProbeOnly` 真实启动验证，起不来就恢复坏现场、绝不动正在跑的服务
- **回滚锚点只在"重启后验证过健康"才更新**——装了插件没重启，锚点仍是装之前
- **现场保留**：每次回滚把坏状态存 `snapshots\crash-<时间>\`，供事后排查
- **防风暴**：回滚失败后 10 分钟内不再自动折腾，事件里写明需人工介入
- **日志崩溃特征扫描**：`dsh-server.log` 增量扫描 `Node.js v|ValidationError|plugin tree failed to load` 等

## 三、日常使用

```powershell
# 看当前状态 + 快照列表
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\dsh-snapshot.ps1 -List

# 手工快照（装插件/改配置前，推荐养成习惯）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\dsh-snapshot.ps1 -Take -Name 装modlens前

# 验证通过后标记为健康锚点
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\dsh-snapshot.ps1 -MarkHealthy -Name 装modlens前

# 手动回滚（会重启服务！先看清单）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\dsh-rollback.ps1 -Snapshot 装modlens前

# 只恢复+探针、不重启（演练用）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\dsh-rollback.ps1 -Auto -NoRestart

# 看门狗立即跑一轮（计划任务之外）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\watchdog-dsh.ps1

# 一键急救（崩溃后双击桌面「DSH 医生急救」）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\dsh-doctor-oneclick.ps1

# 装/卸计划任务
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\install-watchdog.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\install-watchdog.ps1 -Remove
```

## 四、注意事项

- **崩溃后急救**：桌面「DSH 医生急救」文件夹里有同名快捷方式（`dsh-doctor-oneclick.ps1`）——先探测当前配置：能启动 → 安全重启；已损坏 → 自动回滚到最近健康快照再重启；最后验证 HTTP 200 并报告。窗口可见、自动保持 8 秒。重装：`install-doctor-shortcut.ps1`（会写进该文件夹）
- **重启/回滚会短暂断开正在进行的对话**（会话数据在磁盘，页面刷新即恢复）——这是特性不是 bug
- 火绒若弹拦截窗口，点"允许/放行"（老规矩）
- 看门狗只动三件套；`settings.yaml`（GUI 设置）不在回滚范围，不受影响
- 手工调试时若不想被自动回滚打扰：可以临时卸任务（`install-watchdog.ps1 -Remove`），弄完再装回
- 事件日志 `watchdog.log` 是给人和 AI 看的排查第一手材料
- ⚠ 给 5.1 的 ps1 加中文后必须带 **UTF-8 BOM**（`EF BB BF`），否则按 ANSI 解析会炸（doctor 脚本踩过）

## 五、2026-08-18 交付记录

- 基线快照 `baseline-20260818-212801` 已标记 `[H]`（bundle: base + web-app + modlens）
- 演练记录：patch 改坏（session-title 缺字段）→ 回滚到基线 → 探针 PASS → 恢复干净
- 演练残留：`snapshots\auto-20260818-212819`（timer 禁用样本）、`snapshots\crash-20260818-212828`（坏配置样本），保留作教材
