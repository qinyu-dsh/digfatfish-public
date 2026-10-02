"""生成"待人工复核"清单：把机械检查 + 模型复核的结果合并、定级、并附上原文对照

用法: python review_list.py <pdf> <流水线输出目录> [--chunk 1600]

定级规则:
  3 = 严重(模型判失败 / 疑似拒答 / 疑似重复幻觉 / 疑似未译)
  2 = 需看(模型判存疑 / 复核标记有增删或未译)
  1 = 留意(长度比异常 / 段落数偏差 / 长度比可疑)
  0 = 通过
"""
import sys, json, re, pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pdftext import load_paragraphs
from pipeline import chunk_paras

pdf = pathlib.Path(sys.argv[1])
outdir = pathlib.Path(sys.argv[2])
chunk_size = 1600
if '--chunk' in sys.argv:
    chunk_size = int(sys.argv[sys.argv.index('--chunk') + 1])
stem = pdf.stem


def load_jsonl(p):
    d = {}
    if p.exists():
        for line in p.read_text(encoding='utf-8').splitlines():
            if line.strip():
                o = json.loads(line)
                d[o['i']] = o
    return d


paras = load_paragraphs(pdf, verbose=False)
chunks = chunk_paras(paras, chunk_size)
tr = load_jsonl(outdir / f"{stem}.translate.chunks.jsonl")
qa = load_jsonl(outdir / f"{stem}.translate.qa.jsonl")

items = []
for i, o in sorted(tr.items()):
    src = chunks[i] if i < len(chunks) else ''
    src_clean = re.sub(r'(?:\s*[.·]\s*){3,}', ' ', src)      # 去目录点线
    ratio = len(o['text']) / max(len(src_clean), 1)
    q = qa.get(i, {}).get('qa', {})
    verdict, reason = q.get('判定', ''), q.get('理由', '')
    issues, sev = [], 0
    if verdict == '失败':
        sev = 3
    elif verdict == '存疑':
        sev = max(sev, 2)
    # 兼容两种字段极性：段落一致=false 是问题；有增删/有未译/未译内容=true 是问题
    problems = []
    if q.get('段落一致') is False or q.get('段落不对应') is True:
        problems.append('段落不对应')
    if q.get('有增删') is True:
        problems.append('有增删')
    if q.get('有未译') is True or q.get('未译内容') is True:
        problems.append('有未译')
    if problems:
        sev = max(sev, 2)
        issues.append('复核标记 ' + '、'.join(problems))
    for it in o.get('issues', []):
        if it.startswith('长度比'):      # 流水线存的是未去点线的旧比值，这里已用更好的公式重算
            continue
        issues.append(it)
        sev = max(sev, 3 if any(k in it for k in ('拒答', '重复', '未译')) else 1)
    # EN->ZH 正常字符比约 0.22~0.55（中文信息密度高），只有明显偏低才值得看
    if ratio < 0.20 or ratio > 1.0:
        sev = max(sev, 1)
        issues.append(f'长度比异常({ratio:.2f})')
    elif ratio < 0.24:
        sev = max(sev, 1)
        issues.append(f'长度比偏低({ratio:.2f})')
    items.append(dict(i=i, sev=sev, ratio=ratio, src_len=len(src), out_len=len(o['text']),
                      ct=o['ct'], sec=o['sec'], issues=issues, verdict=verdict,
                      reason=reason, src=src, out=o['text']))

tot_ct = sum(o['ct'] for o in tr.values())
tot_sec = sum(o['sec'] for o in tr.values())
buckets = {3: [], 2: [], 1: [], 0: []}
for x in items:
    buckets[x['sev']].append(x)

# ---------- 报告文件 ----------
L = [f"# 待人工复核清单 · {stem}", "",
     f"- 已完成 {len(tr)} 块，共 {sum(len(c) for c in chunks)} 字符",
     f"- 输出 {tot_ct} tokens / {tot_sec/60:.1f} 分钟 / 平均 {tot_ct/max(tot_sec,.1):.1f} token/s",
     f"- 模型复核覆盖 {len(qa)} 块" + ("（复核未完成或未开启）" if len(qa) < len(tr) else ""),
     "",
     f"| 级别 | 块数 | 含义 |", "|---|---|---|",
     f"| 🔴 严重 | {len(buckets[3])} | 疑似拒答/重复/未译，或模型判失败 |",
     f"| 🟠 需看 | {len(buckets[2])} | 模型判存疑，或复核标记有增删/未译 |",
     f"| 🟡 留意 | {len(buckets[1])} | 长度比或段落数异常，多为版式原因 |",
     f"| ✅ 通过 | {len(buckets[0])} | 机械检查与模型复核均通过 |", ""]

for lvl, title in ((3, '🔴 严重'), (2, '🟠 需看'), (1, '🟡 留意')):
    if not buckets[lvl]:
        continue
    L += [f"## {title}（{len(buckets[lvl])} 块）", ""]
    for x in buckets[lvl]:
        L += [f"### 块 {x['i']+1}　长度比 {x['ratio']:.2f}　源 {x['src_len']} 字 → 译 {x['out_len']} 字",
              "", f"- 机械检查：{'；'.join(x['issues']) if x['issues'] else '无'}",
              f"- 模型复核：{x['verdict'] or '未复核'}　{x['reason']}", "",
              "**原文**", "", "```", x['src'][:700], "```", "",
              "**译文**", "", "```", x['out'][:700], "```", ""]

(outdir / f"{stem}.待人工复核.md").write_text("\n".join(L), encoding='utf-8')

# ---------- 终端只打印精简表 ----------
print(f"已完成 {len(tr)} 块  输出 {tot_ct} tokens  {tot_sec/60:.1f} 分钟  "
      f"{tot_ct/max(tot_sec,.1):.1f} tok/s")
print(f"复核覆盖 {len(qa)} 块 | 严重 {len(buckets[3])}  需看 {len(buckets[2])}  "
      f"留意 {len(buckets[1])}  通过 {len(buckets[0])}")
print(f"\n完整报告: {outdir / (stem + '.待人工复核.md')}\n")
print(f"{'块':>4} {'级别':>4} {'比':>5} {'源':>6} {'译':>6} {'出tok':>6}  原因")
for x in sorted([y for y in items if y['sev'] > 0], key=lambda y: (-y['sev'], y['i'])):
    why = '；'.join(x['issues'])
    if x['reason']:
        why += f" | 复核:{x['reason']}"
    print(f"{x['i']+1:>4} {x['sev']:>4} {x['ratio']:>5.2f} {x['src_len']:>6} "
          f"{x['out_len']:>6} {x['ct']:>6}  {why[:95]}")
