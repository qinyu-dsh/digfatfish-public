"""调试：逐行打印 PDF 的坐标/字号/文本，用来诊断版式问题
用法: python debug_lines.py <pdf> <起页> <止页>
"""
import sys
import pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import pymupdf
from pdftext import normalize, body_size

pdf, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
doc = pymupdf.open(pdf)
bs = body_size(doc)
print(f"正文基准字号 = {bs}\n")
for pno in range(a, b + 1):
    print(f"---------- 第 {pno} 页 ----------")
    rows = []
    for blk in doc[pno - 1].get_text('dict').get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk.get('lines', []):
            t = normalize(''.join(s['text'] for s in ln['spans'])).strip()
            if not t:
                continue
            sz = round(max(s['size'] for s in ln['spans']), 1)
            rows.append((round(ln['bbox'][1], 1), round(ln['bbox'][0], 1), sz, t))
    rows.sort(key=lambda r: (r[0], r[1]))
    for y, x, sz, t in rows[:6]:
        mark = '大字号' if sz >= bs * 1.08 else '  '
        print(f"  y={y:7.1f} x={x:6.1f} size={sz:5.1f} {mark} | {t[:78]}")
    if len(rows) > 6:
        print(f"  ...（本页共 {len(rows)} 行）")
    print()
