"""验证假设：块越大，模型越容易"压缩/总结"而不是逐句翻译
用法: python ratio_by_size.py <pdf> <流水线输出目录> [--chunk 1600]
"""
import sys, json, pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pdftext import load_paragraphs
from pipeline import chunk_paras

pdf = pathlib.Path(sys.argv[1])
outdir = pathlib.Path(sys.argv[2])
chunk_size = 1600
if '--chunk' in sys.argv:
    chunk_size = int(sys.argv[sys.argv.index('--chunk') + 1])

chunks = chunk_paras(load_paragraphs(pdf, verbose=False), chunk_size)
tr = {}
for line in (outdir / f"{pdf.stem}.translate.chunks.jsonl").read_text(encoding='utf-8').splitlines():
    if line.strip():
        o = json.loads(line); tr[o['i']] = o

buckets = [(0, 1200), (1200, 2000), (2000, 3000), (3000, 4500), (4500, 7000), (7000, 99999)]
print(f"{'源字符区间':>14} {'块数':>5} {'平均比值':>9} {'中位比值':>9} {'最低比值':>9}  {'比值<0.22 的块数':>14}")
for lo, hi in buckets:
    rs = [len(tr[i]['text']) / len(chunks[i]) for i in sorted(tr)
          if i < len(chunks) and lo <= len(chunks[i]) < hi]
    if not rs:
        continue
    rs.sort()
    low = sum(1 for r in rs if r < 0.22)
    print(f"{f'{lo}-{hi}':>14} {len(rs):>5} {sum(rs)/len(rs):>9.3f} {rs[len(rs)//2]:>9.3f} "
          f"{rs[0]:>9.3f}  {low:>14}")

oversize = [i for i in sorted(tr) if i < len(chunks) and len(chunks[i]) > 3000]
print(f"\n超过 3000 字的单块共 {len(oversize)} 个，块号：{[i+1 for i in oversize]}")
