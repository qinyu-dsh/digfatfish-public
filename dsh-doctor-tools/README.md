# dsh-doctor-tools

DSH（DeepSeek Harness）桌面版的**医生与运维脚本集**——用来诊断、重启、备份、迁移、回滚这套 harness 的工具箱。

> ⚠️ **本仓库是过滤+脱敏后的副本**，原目录见文末"来源与过滤规则"。

---

## 这批脚本干什么

| 方向 | 代表脚本 | 用途 |
|---|---|---|
| **看门狗** | `watchdog-dsh.ps1`、`watchdog-common.ps1`、`install-watchdog.ps1` | 监控服务存活，挂了自动拉起 |
| **重启 / 拉起** | `restart-dsh.ps1`、`restart-dsh-taskboard.ps1` | 安全重启（避开"从会话里同步杀会杀掉自己"的坑） |
| **会话救回** | `restore-sessions.ps1`、`restore-sessions.cjs`、`restore-sessions-index.cjs`、`session-db-prefix.cjs` | 会话丢失/删除后从 sqlite 备份恢复 |
| **插件管理** | `manage-plugins.ps1`、`plugin-audit.cjs` | 查插件挂载状态、审计 |
| **快照 / 回滚** | `dsh-snapshot.ps1`、`dsh-rollback.ps1`、`pre-update-fingerprint.cjs`、`post-update-check.cjs` | 更新前后指纹对比、出问题回滚 |
| **整体备份** | `backup-dsh-full.cjs` | 全量备份（含 `fs.cpSync 会把 Node 进程打死` 那个坑的绕过） |
| **环境迁移** | `family-migration.ps1`、`family-migration-profile.mjs` | profile 迁移（改 home 目录那种高危操作） |
| **诊断** | `health.cjs`、`fix-projcache.cjs`、`fix-projcache-restart.ps1` | 健康检查、缓存修复 |
| **杂项** | `make-doctor-icon.ps1`、`install-doctor-shortcut.ps1`、`make-long-image.ps1` | 图标、快捷方式、长图 |

---

## 用之前必读

这些脚本是在**一台具体机器上长出来的**，里面写死了当时的路径、端口、任务名。移植前必须核对：

1. **路径**：`<user>` / `<computer>` 是脱敏占位符，要换回你自己的
2. **端口**：DSH 桌面 Host 用 **19387**（仅 127.0.0.1），不是 1234（那是 LM Studio）
3. **⛔ 重启类操作绝不能从会话里同步执行** —— 会杀掉承载当前会话的服务（脚本注释原话：`the kill step takes down the caller's session`）。要先武装救援再点火，并接受"预期断线"
4. **备份工具必须验证产物** —— `exit 0` 或"看起来跑完了"都不算数，要核对文件数/manifest/关键大件
5. **`.ps1` 保持 CRLF + BOM，笔记保持 LF** —— 改错行尾会让 PowerShell 5.1 读中文乱码

---

## 来源与过滤规则

**源目录**：`<user>\Desktop\0001\历史记录\DSH-存档-20260930\02-医生与运维脚本`（373 文件 / 9.9 MB）

**保留规则**

```
✅ 扩展名白名单：.ps1 .cjs .mjs .cmd .sh .md .json .yml .yaml
⛔ 排除路径含：probe- / backup- / .bak- / credentials / _build\
⛔ 排除内容含疑似真密钥的文件
✅ 个人标识统一替换为 <user> / <computer> / <github-user>
```

**过滤结果**

| 结果 | 数量 |
|---|---|
| ✅ 保留 | **98 个 / 634 KB** |
| ⛔ 扩展名不符（`.log` `.sqlite` `.jsonl` `.err` `.out` 等） | 145 个 |
| ⛔ 路径黑名单（探针/备份/历史副本） | 127 个 |
| ⛔ **内容含疑似真密钥** | 3 个 |
| 复查残留个人标识 / 密钥 | ✅ 无 |

**被排除的高危内容**（原目录里确实存在，这就是不能原样分享的原因）：

- 凭据文件 `.credentials.yaml` —— **6 个**
- 会话数据库 `sessions.sqlite*` —— **11 个 / 5.0 MB**
- 会话正文 `session.v4.jsonl` —— 1 个 / 822 KB
- 日志 `*.log` —— 40 个 / 1.1 MB（其中 `dsh-server.log` 含 **60 个 43 字符的真 token**）
- 备份 `backup-2026*` —— 5 个 / 4.9 MB

---

## 说明

脚本按原样提供，作者保留所有权利。用前请自行核对路径与副作用，尤其是**重启类**和**迁移类**脚本。
