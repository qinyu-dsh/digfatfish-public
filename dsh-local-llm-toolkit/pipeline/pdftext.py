"""结构感知的 PDF 文本提取：区分标题/正文/页眉/页码，按段落还原。

比 page.get_text('text') 强的地方：
  1. 按页面坐标 (y,x) 排序 —— 不会被 PyMuPDF 的块顺序打乱（页眉插进段落中间那种事故）
  2. 用字号判定标题 —— 标题不会被粘进正文句子中间
  3. 页眉带识别 —— 按版式（首页前两行 + 与正文的间距）判定，而非靠词频猜
  4. 丢弃页码行；TeX 连字(ﬁ ﬂ)与不换行空格归一化
  5. 正文硬换行接回段落、英文断词连字修复、跨页断段合并
"""
import re
from collections import Counter

import pymupdf

# 页码：纯数字 / 罗马数字 / 前后带装饰符的数字（不含小数点，避免把小节号 1.5 当页码）
PAGENO_RE = re.compile(r'^(?:\d{1,4}|[ivxlcIVXLC]{1,6}|[·\-–—]\s*\d{1,4})$')
SECHEAD_RE = re.compile(r'^\d+\.\d*\.?\s+[A-Z]')

LIG = {'\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi',
       '\ufb04': 'ffl', '\ufb05': 'ft', '\ufb06': 'st', '\u00a0': ' '}


def normalize(s):
    for k, v in LIG.items():
        s = s.replace(k, v)
    return s


def page_lines(page):
    """返回 [{'y','x','s'(字号),'t'(文本)}]，严格按 (y,x) 排序"""
    items = []
    for blk in page.get_text('dict').get('blocks', []):
        if blk.get('type') != 0:
            continue
        for ln in blk.get('lines', []):
            t = normalize(''.join(s['text'] for s in ln['spans'])).strip()
            if not t:
                continue
            items.append({'y': round(ln['bbox'][1], 1), 'x': round(ln['bbox'][0], 1),
                          's': round(max(s['size'] for s in ln['spans']), 1), 't': t})
    items.sort(key=lambda r: (r['y'], r['x']))
    return items


def body_size(doc, limit=None):
    """正文基准字号 = 承载字符数最多的字号"""
    c = Counter()
    for i, page in enumerate(doc):
        if limit and i >= limit:
            break
        for ln in page_lines(page):
            c[ln['s']] += len(ln['t'])
    return c.most_common(1)[0][0] if c else 10.0


def _head_band(lines):
    """判断页面顶部有几行属于页眉带（与正文有明显更大间距）"""
    if len(lines) < 2:
        return 0
    if len(lines) < 3 or lines[1]['y'] - lines[0]['y'] > 18:
        return 1
    if lines[1]['y'] - lines[0]['y'] < 12 and lines[2]['y'] - lines[1]['y'] > 18:
        return 2
    return 0


def load_paragraphs(pdf_path, pages=None, verbose=False):
    """返回 [{'type':'h'|'p', 'text':...}]，已清理页眉/页脚/页码"""
    doc = pymupdf.open(str(pdf_path))
    want = list(range(1, doc.page_count + 1)) if not pages else pages
    bs = body_size(doc)
    all_lines = {p: page_lines(doc[p - 1]) for p in want}

    freq = Counter()
    for ls in all_lines.values():
        for t in {ln['t'] for ln in ls}:
            freq[t] += 1

    paras, dropped = [], []
    for p in want:
        ls = all_lines[p]
        head_n = _head_band(ls)
        buf = ''
        for idx, ln in enumerate(ls):
            t, sz = ln['t'], ln['s']
            if PAGENO_RE.match(t):
                dropped.append(t); continue
            if sz >= bs * 1.08 and len(t) < 80:          # 大字号短行 = 标题
                if buf:
                    paras.append({'type': 'p', 'text': buf}); buf = ''
                paras.append({'type': 'h', 'text': t})
                continue
            if (idx < head_n and len(t) < 90
                    and (t.isupper() or SECHEAD_RE.match(t) or freq[t] >= 2)):
                dropped.append(t); continue               # 页眉带里的页眉
            if buf.endswith('-') and t[:1].islower():
                buf = buf[:-1] + t
            else:
                buf = (buf + ' ' + t).strip() if buf else t
        if buf:
            paras.append({'type': 'p', 'text': buf})

    # 跨页断段合并：上段无句末标点 + 下段小写开头
    merged = []
    for x in paras:
        if (merged and merged[-1]['type'] == 'p' and x['type'] == 'p'
                and not re.search(r'[.!?:;"”\)\]。！？]$', merged[-1]['text'])
                and x['text'][:1].islower()):
            merged[-1]['text'] = merged[-1]['text'].rstrip('-') + ' ' + x['text']
        else:
            merged.append(x)

    # 标题合并："1.5" + "Collegiality" -> "1.5 Collegiality"；"第二章" + "你的职责"
    out = []
    for x in merged:
        if (out and out[-1]['type'] == 'h' and x['type'] == 'h'
                and (re.fullmatch(r'\d+(\.\d+)*\.?', out[-1]['text'])
                     or re.fullmatch(r'(第[一二三四五六七八九十百千]+[章节部分篇]|Chapter\s+\d+)', out[-1]['text']))):
            out[-1]['text'] = out[-1]['text'].rstrip('.') + ' ' + x['text']
        else:
            out.append(x)
    merged = out

    if verbose:
        uniq = list(dict.fromkeys(dropped))
        print(f"  正文基准字号 {bs}；丢弃页眉/页码 {len(dropped)} 行（{len(uniq)} 种），例如 {uniq[:4]}")
    return merged


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    ps = load_paragraphs(sys.argv[1], verbose=True)
    print(f"共 {len(ps)} 段（标题 {sum(1 for x in ps if x['type'] == 'h')} 条），"
          f"总字符 {sum(len(x['text']) for x in ps)}")
