"""把 PDF 拆成可用文本：pdf -> 每页文本 + 全文 + 统计
 
用法: python extract.py <pdf> <输出目录>
"""
import sys, json, pathlib, re

sys.stdout.reconfigure(encoding='utf-8')
import pymupdf

pdf_path = sys.argv[1]
outdir = pathlib.Path(sys.argv[2])
outdir.mkdir(parents=True, exist_ok=True)

doc = pymupdf.open(pdf_path)
print(f"页数: {doc.page_count}")
meta = {k: v for k, v in (doc.metadata or {}).items() if v}
print(f"元数据: {json.dumps(meta, ensure_ascii=False)}")

pages = []
for i, page in enumerate(doc):
    pages.append(page.get_text("text"))

# 统计
lens = [len(p.strip()) for p in pages]
empty = sum(1 for n in lens if n < 30)
full = "\n\n".join(pages)
cjk = len(re.findall(r'[\u4e00-\u9fff]', full))
latin = len(re.findall(r'[A-Za-z]', full))
print(f"\n总字符: {len(full)}   非空页: {doc.page_count - empty} / {doc.page_count}")
print(f"每页字符 中位={sorted(lens)[len(lens)//2]}  最大={max(lens)}  最小={min(lens)}")
print(f"中文 {cjk} 字 / 拉丁 {latin} 字符 -> 判定: {'中文' if cjk > latin else '英文'}文档")
print(f"疑似无文本层(需OCR)的页: {empty}")

(outdir / f"{pathlib.Path(pdf_path).stem}.pages.json").write_text(
    json.dumps(pages, ensure_ascii=False), encoding="utf-8")
(outdir / f"{pathlib.Path(pdf_path).stem}.txt").write_text(full, encoding="utf-8")

print("\n" + "=" * 60)
print("第 1 页前 700 字：")
print("=" * 60)
print(pages[0][:700])
