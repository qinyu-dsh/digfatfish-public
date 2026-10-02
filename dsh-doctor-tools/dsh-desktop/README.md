# DeepSeek Harness 桌面启动器

把 DSH（DeepSeek Harness，就是"我"）变成"桌面应用"的启动方案。
原理：DSH 本身是 **本地 Web 服务（http://127.0.0.1:3080）+ 浏览器界面**，没有内置 Electron 外壳，
所以用"**后台常驻服务 + Edge 应用模式独立窗口**"来实现同样的体验：双击图标 → 秒开、独立窗口、任务栏图标。

## 为什么你之前启动慢

1. **npx 开销**：每次 `npx ...` 都要重新解析包、检查版本，白白多花 1~3 秒。
2. **冷启动开销**：`dsh web` 每次要加载插件树和配置，约几秒（取决于机器与插件数量）。
3. **无常驻**：用完就关，下次又全量重来。

本方案：全局安装去掉 npx 开销（第 1 步，可选但推荐）；开机自启让服务常驻，去掉冷启动开销（第 2 步）；桌面快捷方式用 Edge 应用模式打开，得到桌面应用体验（第 3 步）。

## 安装步骤（共三步，只需做一次）

### 第 1 步（可选但推荐）：全局安装 dsh，绕开 npx

在任意终端执行：

```
npm i -g @deepseek-ai/dsh
```

装完后 `dsh` 就是系统命令，启动脚本会优先使用它。
（如果不想全局安装也可以跳过，启动脚本会自动退回 `npx --yes @deepseek-ai/dsh`，只是每次稍慢。）

### 第 2 步：创建桌面快捷方式 + 开机自启

双击本文件夹里的 **`install-shortcut.bat`**：

- 在桌面创建 **DeepSeek Harness** 快捷方式（Edge 图标）；
- 在"启动"文件夹创建 **DSH Background Server** 快捷方式 → 开机自动在后台启动服务（隐藏窗口，无弹窗）。

不想开机自启的话，执行：`powershell -NoProfile -ExecutionPolicy Bypass -File install-shortcut.ps1 -NoAutoStart`

### 第 3 步：使用

以后双击桌面 **DeepSeek Harness** 图标即可：

- 服务已在运行（自启或手动开着）→ **立即**弹出独立窗口，几乎零等待；
- 服务没在运行 → 脚本会先静默拉起服务（后台窗口，日志写入 `dsh-server.log`），等端口就绪后打开窗口。

## 常用命令（手动）

| 想做什么 | 命令 |
|---|---|
| 后台启动服务（隐藏窗口） | `powershell -NoProfile -ExecutionPolicy Bypass -File start-server.ps1` |
| 直接打开界面 | 双击桌面 **DeepSeek Harness** |
| 手动前台启动（看日志） | `dsh web`（或 `npx --yes @deepseek-ai/dsh web`） |
| 换端口 | `dsh web --port 8080`（需同步改脚本里的 `$Port`） |
| 查看服务日志 | 本文件夹 `dsh-server.log` |

## 卸载

1. 删除桌面 **DeepSeek Harness** 快捷方式；
2. 删除"启动"文件夹里的 **DSH Background Server**（按 `Win+R` 输入 `shell:startup` 打开）；
3. 如需移除全局安装：`npm rm -g @deepseek-ai/dsh`；
4. 本文件夹删除即可（不影响 `C:\Users\<user>\.dsh` 里的配置和会话数据）。

## 说明

- 端口 3080 已被占用时脚本不会重复启动服务，直接打开窗口——所以即使你正用着其他方式启动的 DSH，也不会冲突。
- 后台服务由隐藏的 PowerShell 进程托管，注销/关机时自动结束；开机自启会在登录后自动拉起。
- 若服务启动失败，脚本会弹窗提示，日志在 `dsh-server.log`。
- 快捷方式图标：官方 DeepSeek 标志（白色标志 + 深色圆角方块，取自 DSH 自带的 `favicon.svg`）。dsh 升级后想重新生成图标，双击运行 `build-icon.ps1` 即可（产物：`deepseek.svg` / `deepseek-256.png` / `deepseek.ico`）。
- 插件小工具 `enable-link-default.ps1`：给 dsh CLI 打补丁，让 `dsh plugin ... add file:./本地插件` 默认以 `link:`（实时软链）安装而不是快照复制；dsh 升级后重跑一次，回滚用 `-Revert`。详见 `D:\dhs01\dsh-sample-plugin\README.md`。
