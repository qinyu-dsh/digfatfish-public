"""诊断指定块：对比原文结尾与译文结尾，判断是"漏译/截断"还是"中文压缩"

用法: python tails.py <pdf> <流水线输出目录> <块号...> [--chunk 1600]
"""
import sys, json, pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pdftext import load_paragraphs
from pipeline import chunk_paras

pdf = pathlib.Path(sys.argv[1])
outdir = pathlib.Path(sys.argv[2])
ids = [int(x) - 1 for x in sys.argv[3:] if x.isdigit()]
chunk_size = 1600
if '--chunk' in sys.argv:
    chunk_size = int(sys.argv[sys.argv.index('--chunk') + 1])

paras = load_paragraphs(pdf, verbose=False)
chunks = chunk_paras(paras, chunk_size)
tr = {}
for line in (outdir / f"{pdf.stem}.translate.chunks.jsonl").read_text(encoding='utf-8').splitlines():
    if line.strip():
        o = json.loads(line); tr[o['i']] = o

for i in ids:
    src, o = chunks[i], tr.get(i)
    if not o:
        print(f"块 {i+1}: 无译文"); continue
    out = o['text']
    print("=" * 78)
    print(f"块 {i+1}  源 {len(src)} 字 -> 译 {len(out)} 字  比值 {len(out)/len(src):.2f}  "
          f"段落数 源{len(src.split(chr(10)+chr(10)))} -> 译{len(out.split(chr(10)+chr(10)))}")
    print(f"--- 原文结尾 260 字 ---\n...{src[-260:]}")
    print(f"--- 译文结尾 260 字 ---\n...{out[-260:]}")
    # 译文最后一句是否与原文结尾呼应
    print()
