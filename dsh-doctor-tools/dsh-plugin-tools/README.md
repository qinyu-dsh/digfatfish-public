# 插件启停管理工具（脚本级）

类似 RimWorld mod 列表的**命令行版**：查看全部插件（含启停状态）、一键启用/禁用。

## 用法

```powershell
# 查看全部插件（ON/OFF 状态、来源层、包名）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\manage-plugins.ps1 list

# 禁用某个插件（如关闭定时器）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\manage-plugins.ps1 disable timer

# 重新启用
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\manage-plugins.ps1 enable timer
```

输出示例：

```
[ON ] llm    (@deepseek-ai/dsh-llm)      [@deepseek-ai/dsh-base]
[OFF] hmr    (@deepseek-ai/cordis-plugin-hmr)  [@deepseek-ai/dsh-base]  *disabled-in-patch
[ON ] session-title  (@deepseek-ai/dsh-session-title)  [@deepseek-ai/dsh-base, patched by dsh-sample-plugin]
```

- `*disabled-in-patch` = 由你的 profile 补丁层（`cordis.patch.yml`）禁用，工具可直接改回来
- 其它 OFF 条目（如 `hmr`）是官方 bundle 层禁用的，改它们需要编辑补丁层（见下）

## 工作原理与安全

- 启用/禁用 = 往你的 `C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml`（用户补丁层）
  添加/移除 `- id: xxx` + `disabled: true` 行
- 每次修改前**自动备份**到 `D:\dhs01\dsh-plugin-tools\backups\`
- 修改后**双重校验**，失败自动还原备份：
  1. **组成检查**：`dsh --profile web --dump-config`（exit 0）
  2. **启动探针**：在空闲端口真实启动一个临时实例并确认 HTTP 可访问
     （⚠ dump-config 只校验组成、不校验配置——2026-08-17 事故证明
      "dump-config 全绿但启动即崩"是真实存在的盲点，探针才是唯一可靠的判定）
- **绝不触碰正在运行的服务**——修改在下次重启后生效
  （重启：任务管理器结束 3080 端口的 node 进程 → 双击桌面 DeepSeek Harness）

## 安全重启脚本 restart-dsh.ps1（探针先行）

```powershell
# 完整重启：探针 → 通过才杀旧服务 → 起新服务 → 真实启动验证
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\restart-dsh.ps1

# 只跑探针（不重启，用于检查当前补丁能否启动）
powershell -NoProfile -ExecutionPolicy Bypass -File D:\dhs01\dsh-plugin-tools\restart-dsh.ps1 -ProbeOnly
```

**保证条款**（2026-08-17 事故后加固）：

- **探针先行**：重启前先在空闲端口真实启动一次。当前补丁无法启动时，
  脚本**立即中止并拒绝杀掉正在运行的健康服务**——绝不允许
  "杀健康服务 → 换成会崩的新服务"（上次事故的完整路径）。
- 探针通过后才杀 3080 旧服务 → 起新服务 → 以 **HTTP 200（真实启动）**
  作为最终判定，dump-config 仅作参考信息。
- 判定与结果全部写入 `restart-check.log`（含 ABORT 原因）。
- 适合放入计划任务无人值守执行；任务跑完自删。

## 注意事项

- 禁用的条目 id 必须来自 `list` 输出（组合树里真实存在的行）
- 想**禁用由官方 bundle 层启用的**条目（如 `hmr`）——直接 `disable` 会在用户补丁层
  追加一行覆盖它，同样生效，因为补丁层按 id 覆盖
- 安装/移除整个插件包（bundle）仍用 `dsh plugin --profile web add/remove <包名>`
- 恢复误操作：改坏了会自动还原；也可手动用 `backups\` 里的文件覆盖回去

## 关于应用内页面

设置 → 插件 已有两个标签页：

- **插件清单**：只读列表（状态/搜索/详情），本工具的"查看"对应它
- **插件配置**：可配置插件的卡片式编辑

官方目前未开放 UI 启停，本工具补上"启停"这一环；等官方支持后可直接切换。
