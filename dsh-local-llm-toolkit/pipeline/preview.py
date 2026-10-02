"""预览某几页的提取结果：python preview.py <pdf> <页码范围，如 20-25>
用来肉眼核对标题/段落是否还原正确，再去跑流水线。
"""
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(__import__('pathlib').Path(__file__).parent))
from pdftext import load_paragraphs

pdf = sys.argv[1]
spec = sys.argv[2] if len(sys.argv) > 2 else ''
pages = []
if spec:
    for part in spec.split(','):
        if '-' in part:
            a, b = part.split('-')
            pages += list(range(int(a), int(b) + 1))
        else:
            pages.append(int(part))

ps = load_paragraphs(pdf, pages=pages or None, verbose=True)
hs = sum(1 for x in ps if x['type'] == 'h')
print(f"共 {len(ps)} 段（标题 {hs} 条），总字符 {sum(len(x['text']) for x in ps)}")
print("=" * 70)
for x in ps:
    tag = '【标题】' if x['type'] == 'h' else '正文  '
    print(f"{tag} {x['text'][:150]}")
