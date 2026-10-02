"""把超长块的记录从 chunks.jsonl / qa.jsonl 中摘掉（自动备份），好让 pipeline 重跑时只重做这些块

用法: python repair_oversize.py <pdf> <流水线输出目录> [--min 4500] [--chunk 1600]
"""
import sys, json, shutil, pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pdftext import load_paragraphs
from pipeline import chunk_paras

pdf = pathlib.Path(sys.argv[1])
outdir = pathlib.Path(sys.argv[2])
mn, chunk_size = 4500, 1600
if '--min' in sys.argv:
    mn = int(sys.argv[sys.argv.index('--min') + 1])
if '--chunk' in sys.argv:
    chunk_size = int(sys.argv[sys.argv.index('--chunk') + 1])

chunks = chunk_paras(load_paragraphs(pdf, verbose=False), chunk_size)
targets = {i for i in range(len(chunks)) if len(chunks[i]) >= mn}
print(f"共 {len(chunks)} 块，其中 >= {mn} 字的超长块 {len(targets)} 个：{[i+1 for i in sorted(targets)]}")

for name in (f"{pdf.stem}.translate.chunks.jsonl", f"{pdf.stem}.translate.qa.jsonl"):
    p = outdir / name
    if not p.exists():
        print(f"  {name}: 不存在，跳过"); continue
    shutil.copy(p, p.with_suffix(p.suffix + '.bak'))
    keep, drop = [], 0
    for line in p.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        if json.loads(line)['i'] in targets:
            drop += 1
        else:
            keep.append(line)
    p.write_text('\n'.join(keep) + '\n', encoding='utf-8')
    print(f"  {name}: 摘掉 {drop} 条，保留 {len(keep)} 条（原文件已备份为 {name}.bak）")
