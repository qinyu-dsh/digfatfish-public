# dsh-local-llm-toolkit

把 **本地小模型（LM Studio + llama.cpp）当成"外包工人"** 用的一整套脚本与文档。

起因是一个真实任务：把一本 286 页的英文数学专著（63 万字符）在 8GB 显存的笔记本上翻成中文。
所有脚本、参数、坑都是那次跑出来的实测结果，不是抄的教程。

---

## 这套东西解决什么问题

| 问题 | 本仓库的答案 |
|---|---|
| 8GB 显存能跑什么模型、怎么设参数 | `lmstudio/01-傻瓜教程.md` |
| 怎么把 286 页 PDF 喂给本地模型 | `pipeline/pdftext.py` + `pipeline/pipeline.py` |
| 本地模型什么时候在"翻译"、什么时候在"编" | `pipeline/ratio_by_size.py` + `check_chunks.py` + `review_list.py` |
| 怎么一条命令给不同模型派不同活 | `lmstudio/05-发号施令.ps1` |
| 本地模型到底省不省钱 | `lmstudio/01-傻瓜教程.md` 附录 A（**实测：不省**） |

---

## 目录

```
lmstudio/           LM Studio 部署与调用
  01-傻瓜教程.md        部署全流程 + 实测数据 + 成本真相附录
  02-一键体检.ps1       显卡/显存/模型目录/服务器/日志 一条命令看完
  03-下载模型.ps1       走 hf-mirror 镜像下载（含磁盘空间预警）
  04-收集日志.ps1       打包日志（自动脱敏，不含聊天记录）
  05-发号施令.ps1       角色派活器：翻译/总结/代码/润色/提问

pipeline/           文档流水线
  pdftext.py           结构感知 PDF 提取（标题/页眉/连字/跨页断段）
  pipeline.py          全书流水线（断点续传 + 两阶段质检）
  extract.py           简易提取（对比用）
  preview.py           预览某几页的提取结果
  debug_lines.py       逐行打印坐标/字号，诊断版式问题
  check_chunks.py      逐块长度比，揪漏译
  tails.py             对比原文结尾与译文结尾
  ratio_by_size.py     验证"块越大越会被压缩"这个假设
  review_list.py       生成待人工复核清单
  repair_oversize.py   摘除超长块记录以便重做
  count_tokens.py      用真 tokenizer 数成本

docs/
  本地小模型调用指南.md   完整调用契约（新会话开工前必读）
```

---

## 环境要求

- **LM Studio 0.4+**，且已装 `llama.cpp` 的 CUDA 后端（应用会自动装）
- 一个能跑 7B Q4_K_M 的 GPU（**8GB 显存起**，实测 RTX 4060 Laptop 可用）
- Python 3.10+，需要 `pymupdf`；`count_tokens.py` 另需 `tiktoken`
- 网络：能访问 `hf-mirror.com`（HuggingFace 直连不通时用它）

```powershell
pip install pymupdf tiktoken
```

---

## 快速开始

```powershell
# 1. 部署模型（会从 hf-mirror 下载约 13GB）
.\lmstudio\03-下载模型.ps1

# 2. 体检：确认模型目录、显存、服务器状态
.\lmstudio\02-一键体检.ps1

# 3. 开本地服务器（默认 127.0.0.1:1234，OpenAI 兼容）
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" server start

# 4. 派活
.\lmstudio\05-发号施令.ps1 翻译 "The quick brown fox jumps over the lazy dog."
.\lmstudio\05-发号施令.ps1 代码 "用 Python 写一个快速排序，带注释"

# 5. 跑文档流水线（先小范围试跑，看质量和速度）
python pipeline\pipeline.py 你的书.pdf translate --pages 20-25 --qa
```

---

## 用之前必须知道的 5 条（全是踩出来的）

1. **1234 端口不会自启** —— 重启后 LM Studio 在跑，但端口拒连，必须先 `lms server start`
2. **8GB 显存一次只站一个 7B** —— 换模型要 20–40 秒，别设计"两个模型轮流上"的流程
3. **绝不让第二个模型被 JIT 偷加载** —— 实测撞到两个 7B 同时驻留，显存只剩 **150 MiB**；质检必须**两阶段**（先跑完，再换模型统一复核）
4. **单块别超 1800 字** —— 超长块它会"总结"而不是翻译：实测译文/原文比值从 0.34 掉到 **0.20**
5. **它当裁判不可信** —— 19 条自动报警里 **7 条是误报**；它只能当筛子，真假判定必须回原文核对

> **`Parallel` 参数默认是 4，单用户务必改 1**：实测显存多出 1.4GB，速度从 19 tok/s 涨到 **39 tok/s**。

---

## 一句话结论：别拿"省钱"当用它的理由

286 页那本书的实测账：

| 方案 | 花费 | 时间 |
|---|---|---|
| 全本地（Hunyuan-MT-7B） | **电费 ≈ ¥0.07** | 48 分钟 GPU 满载 |
| 全云端直译（同期某个 Flash 级模型） | **¥0.69**（闲时价） | 几分钟 |
| 本地译 + 云端**全量**精修 | **¥0.96** ⬆️ | 48 分钟 + 人工 |

**本地译一遍、云端再写一遍 = 输出翻倍，反而更贵。** 真正划算的是"本地干完 98.7%，云端只碰出问题的那 1.3%"。

**本地部署买的是隐私、可重复、不受限流，不是省钱。** 判断要不要外包，别问"小模型能不能做"，要问：

> **我能不能便宜地验证它做对了？**

---

## 说明

- 仓库内所有路径已做脱敏（`<user>` / `<computer>` 占位）
- 不含任何凭据、会话记录或日志
- 脚本按原样提供，用前请按你自己机器的路径核对
