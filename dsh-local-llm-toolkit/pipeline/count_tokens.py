"""用真实 tokenizer 数清楚：这本书直译需要多少 token 进、多少出
用法: python count_tokens.py <pdf> <流水线输出目录>
"""
import sys, pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tiktoken
from pdftext import load_paragraphs

pdf = pathlib.Path(sys.argv[1])
outdir = pathlib.Path(sys.argv[2])

# 1) 干净原文（我会实际发出去的那份）
paras = load_paragraphs(pdf, verbose=False)
src = "\n\n".join(('## ' + x['text']) if x['type'] == 'h' else x['text'] for x in paras)

# 2) 本地产出的中文译稿正文
md = (outdir / f"{pdf.stem}.translate.md").read_text(encoding='utf-8')
body = md.split('\n\n', 1)[1]

encs = {'cl100k_base(GPT-4系)': 'cl100k_base', 'o200k_base(GPT-4o/5系)': 'o200k_base'}
print(f"原文 {len(src)} 字符    译文 {len(body)} 字符\n")
for name, enc_name in encs.items():
    e = tiktoken.get_encoding(enc_name)
    a, b = len(e.encode(src)), len(e.encode(body))
    print(f"{name:>24}:  输入 {a:>7,} tokens   输出 {b:>7,} tokens   合计 {a+b:>7,}")
