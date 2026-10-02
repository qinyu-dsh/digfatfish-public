"""本地文档流水线：PDF -> 结构感知提取 -> 分块 -> 本地模型干粗活 -> 质检 -> 产出

用法:
  python pipeline.py <pdf> translate --pages 20-25 --qa
  python pipeline.py <pdf> summarize --qa --qa-every 5
  python pipeline.py <pdf> translate --out "E:\\某目录" --chunk 1800

要点:
  * 断点续跑：每块做完立刻落盘 .chunks.jsonl，中断后重跑自动跳过已完成块
  * 排班：8G 显存只够一个 7B，自动把不对的模型请走再让对的模型上岗
  * 质检：机械检查(段落数/长度比/未译残留/拒答词/重复幻觉) + 模型复核(输出 JSON)
  * 产出的初稿交给云端强模型（DSH）做最后润色
"""
import sys, os, re, json, time, argparse, subprocess, urllib.request, pathlib

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from pdftext import load_paragraphs

LMS  = str(pathlib.Path(os.environ['USERPROFILE']) / '.lmstudio' / 'bin' / 'lms.exe')
BASE = 'http://127.0.0.1:1234'

ROLES = {
    'translate': dict(
        model='hunyuan-mt-7b', temp=0.3, max_tokens=2400,
        sys='你是专业翻译引擎。把用户给的英文翻译成地道、通顺的书面中文。'
            '严格保持原有的段落和标题结构，逐段对应，不增不减不合并。'
            '人名、书名、机构名保留英文原名，首次出现时在后面用括号给出中文译名。'
            '只输出译文，不要任何解释、总结、前言或后语。'),
    'summarize': dict(
        model='qwen2.5-7b-instruct', temp=0.3, max_tokens=900,
        sys='你是文档分析助手。把用户给的一段英文压缩成简洁的中文要点，'
            '只保留事实、数字、结论和建议，分点输出。不要复述原文，不要客套话，不要评价。'),
    'qa': dict(
        model='qwen2.5-7b-instruct', temp=0.0, max_tokens=400,
        sys='你是严格的翻译质检员。给你英文原文和中文译文，只输出一行 JSON，格式：'
            '{"段落不对应":true/false,"有增删":true/false,"有未译":true/false,'
            '"判定":"通过"/"存疑"/"失败","理由":"不超过30字"}。'
            '注意：三个布尔字段都是"有问题才填 true"，没问题一律填 false。'
            '只有确实发现缺陷才判"存疑"或"失败"，不要因为段落数量略有出入就判缺陷。不要输出任何其他文字。'),
}

拒答_PATTERNS = [re.compile(r'(抱歉|对不起)[，,。].{0,10}(无法|不能|做不到)'),
                re.compile(r'作为(一个)?(AI|人工智能|语言模型|助手)'),
                re.compile(r'我(无法|不能)(回答|完成|处理|翻译)'),
                re.compile(r'As an AI')]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def lms(*args, timeout=300):
    """调用 lms 命令行；刻意不用管道抓输出，避免沙箱里的命名管道限制"""
    try:
        subprocess.run([LMS, *args], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=timeout)
    except Exception as e:
        log(f"lms {' '.join(args)} 异常: {e}")


def loaded_models():
    try:
        with urllib.request.urlopen(BASE + '/api/v0/models', timeout=8) as r:
            d = json.loads(r.read().decode('utf-8'))
        return [m['id'] for m in d['data'] if m.get('state') in ('loaded', 'loading')]
    except Exception:
        return []


def ensure_server():
    try:
        urllib.request.urlopen(BASE + '/v1/models', timeout=5).read()
    except Exception:
        log("服务器没开，正在启动...")
        lms('server', 'start')
        time.sleep(5)


def ensure_model(key, ctx=8192):
    cur = loaded_models()
    if key in cur:
        log(f"{key} 已在岗")
        return True
    for m in cur:
        log(f"请 {m} 下班，腾显存")
        lms('unload', m)
    log(f"正在让 {key} 上岗（加载 4.7GB，约 20-40 秒；parallel=1 单用户，省 KV cache）...")
    lms('load', key, '--gpu', 'max', '-c', str(ctx), '--parallel', '1', '-y')
    for _ in range(40):
        if key in loaded_models():
            return True
        time.sleep(3)
    return False


def ask(model, system, user, temp=0.3, max_tokens=2048):
    body = json.dumps({
        'model': model, 'temperature': temp, 'max_tokens': max_tokens,
        'messages': [{'role': 'system', 'content': system},
                     {'role': 'user', 'content': user}],
    }).encode('utf-8')
    req = urllib.request.Request(BASE + '/v1/chat/completions', data=body,
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        j = json.loads(r.read().decode('utf-8'))
    return dict(text=j['choices'][0]['message']['content'].strip(),
                pt=j['usage']['prompt_tokens'], ct=j['usage']['completion_tokens'],
                sec=round(time.time() - t0, 1))


def chunk_paras(paras, size):
    """按段落分块；标题永远和它后面的内容留在同一块"""
    chunks, buf, n = [], [], 0
    for x in paras:
        t = ('## ' + x['text']) if x['type'] == 'h' else x['text']
        if n + len(t) > size and buf:
            chunks.append('\n\n'.join(buf)); buf, n = [], 0
        buf.append(t); n += len(t) + 2
    if buf:
        chunks.append('\n\n'.join(buf))
    return chunks


def split_long(text, limit=1800):
    """超长内容按句子边界切成 <=limit 的子块再送模型。
    实测：单块超过 ~4500 字时模型会"压缩/总结"而不是逐句翻译（比值从 0.34 掉到 0.20）。"""
    if len(text) <= limit:
        return [text]
    parts = []
    for para in text.split('\n\n'):
        if len(para) <= limit:
            parts.append(para); continue
        buf = ''
        for s in re.split(r'(?<=[.!?。！？])\s+', para):
            if len(buf) + len(s) + 1 > limit and buf:
                parts.append(buf); buf = ''
            buf = (buf + ' ' + s).strip() if buf else s
        if buf:
            parts.append(buf)
    out, buf = [], ''
    for p in parts:
        if len(buf) + len(p) + 2 > limit and buf:
            out.append(buf); buf = ''
        buf = (buf + '\n\n' + p).strip() if buf else p
    if buf:
        out.append(buf)
    return out


def mech_check(src, out, mode):
    """机械检查：零成本，先挡掉明显事故"""
    issues = []
    if mode == 'translate':
        sp = len([p for p in src.split('\n\n') if p.strip()])
        op = len([p for p in out.split('\n\n') if p.strip()])
        if sp >= 3 and abs(op - sp) / sp > 0.5:
            issues.append(f"段落数偏差大(原{sp}->译{op})")
        src_clean = re.sub(r'(?:\s*[.·]\s*){3,}', ' ', src)   # 去掉目录点线，避免误判漏译
        ratio = len(out) / max(len(src_clean), 1)
        if not (0.25 <= ratio <= 1.15):
            issues.append(f"长度比异常({ratio:.2f})")
        latin = len(re.findall(r'[A-Za-z]', out)) / max(len(out), 1)
        if latin > 0.6:
            issues.append(f"疑似大段未译(英文占比{latin:.0%})")
    for pat in 拒答_PATTERNS:
        if pat.search(out):
            issues.append(f"疑似拒答：{pat.pattern[:18]}")
    ps = [p.strip() for p in out.split('\n\n') if len(p.strip()) > 60]
    if ps and len(ps) != len(set(ps)):
        issues.append(f"疑似重复段落 x{len(ps) - len(set(ps)) + 1}")
    return issues


def qa_review(src, out):
    try:
        r = ask(ROLES['qa']['model'], ROLES['qa']['sys'],
                f"【英文原文】\n{src}\n\n【中文译文】\n{out}",
                temp=0.0, max_tokens=ROLES['qa']['max_tokens'])
        m = re.search(r'\{.*\}', r['text'], re.S)
        return json.loads(m.group(0)) if m else {'判定': '存疑', '理由': '复核输出非JSON'}
    except Exception as e:
        return {'判定': '存疑', '理由': f'复核失败:{e}'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('mode', choices=['translate', 'summarize'])
    ap.add_argument('--pages', default='', help='如 20-25 或 3,7,9；默认全部')
    ap.add_argument('--chunk', type=int, default=1600, help='每块字符数')
    ap.add_argument('--out', default='', help='输出目录')
    ap.add_argument('--qa', action='store_true', help='开启模型复核')
    ap.add_argument('--qa-every', type=int, default=1, help='每 N 块复核一次（省时间）')
    ap.add_argument('--keep-loaded', action='store_true')
    args = ap.parse_args()

    pdf = pathlib.Path(args.pdf)
    stem = pdf.stem
    outdir = pathlib.Path(args.out) if args.out else pdf.parent / f"{stem}_流水线"
    outdir.mkdir(parents=True, exist_ok=True)
    jsonl = outdir / f"{stem}.{args.mode}.chunks.jsonl"

    ensure_server()
    role = ROLES[args.mode]

    pages = []
    if args.pages:
        for part in args.pages.split(','):
            if '-' in part:
                a, b = part.split('-'); pages += list(range(int(a), int(b) + 1))
            else:
                pages.append(int(part))

    paras = load_paragraphs(pdf, pages=pages or None, verbose=True)
    chunks = chunk_paras(paras, args.chunk)
    log(f"提取到 {len(paras)} 段（标题 {sum(1 for x in paras if x['type']=='h')} 条）"
        f"-> {len(chunks)} 块，共 {sum(len(x['text']) for x in paras)} 字符")

    done = {}
    if jsonl.exists():
        for line in jsonl.read_text(encoding='utf-8').splitlines():
            if line.strip():
                o = json.loads(line); done[o['i']] = o
        log(f"发现已完成 {len(done)} 块，将跳过")

    if not ensure_model(role['model']):
        log("模型加载失败，退出"); return 1

    with jsonl.open('a', encoding='utf-8') as fh:
        for i, ch in enumerate(chunks):
            if i in done:
                continue
            try:
                subs = split_long(ch)
                if len(subs) > 1:
                    log(f"块 {i+1} 超长({len(ch)}字) -> 拆成 {len(subs)} 个子块")
                    texts, pt, ct, sec = [], 0, 0, 0.0
                    for s in subs:
                        rr = ask(role['model'], role['sys'], s, role['temp'], role['max_tokens'])
                        texts.append(rr['text']); pt += rr['pt']; ct += rr['ct']; sec += rr['sec']
                    r = dict(text='\n\n'.join(texts), pt=pt, ct=ct, sec=round(sec, 1))
                else:
                    r = ask(role['model'], role['sys'], ch, role['temp'], role['max_tokens'])
            except Exception as e:
                log(f"块 {i+1}/{len(chunks)} 请求失败: {e}"); continue
            issues = mech_check(ch, r['text'], args.mode)
            rec = dict(i=i, src_len=len(ch), text=r['text'], pt=r['pt'], ct=r['ct'],
                       sec=r['sec'], issues=issues)
            fh.write(json.dumps(rec, ensure_ascii=False) + '\n'); fh.flush()
            done[i] = rec
            flag = ('⚠ ' + '; '.join(issues)) if issues else 'ok'
            log(f"块 {i+1}/{len(chunks)}  {r['ct']}tok/{r['sec']}s  "
                f"{r['ct']/max(r['sec'],.1):.0f}tok/s  {flag}")

    # ---- 第二阶段：复核。翻译全部结束后再换模型，避免两个 7B 同时占显存 ----
    if args.qa:
        qa_jsonl = outdir / f"{stem}.{args.mode}.qa.jsonl"
        qa_done = {}
        if qa_jsonl.exists():
            for line in qa_jsonl.read_text(encoding='utf-8').splitlines():
                if line.strip():
                    o = json.loads(line); qa_done[o['i']] = o
        targets = [i for i in sorted(done) if i % max(args.qa_every, 1) == 0 and i not in qa_done]
        if targets:
            lms('unload', role['model'])
            log(f"复核阶段：请 {ROLES['qa']['model']} 上岗，复核 {len(targets)} 块（每 {args.qa_every} 块抽 1）")
            if ensure_model(ROLES['qa']['model']):
                with qa_jsonl.open('a', encoding='utf-8') as fh:
                    for k, i in enumerate(targets):
                        r = qa_review(chunks[i], done[i]['text'])
                        fh.write(json.dumps({'i': i, 'qa': r}, ensure_ascii=False) + '\n'); fh.flush()
                        qa_done[i] = {'i': i, 'qa': r}
                        log(f"  复核 {k+1}/{len(targets)}  块{i+1}  {r.get('判定')}  {r.get('理由','')}")
            else:
                log("复核模型加载失败，跳过复核")
        for i, o in qa_done.items():
            if i in done:
                done[i]['qa'] = o['qa']

    ordered = [done[i] for i in sorted(done)]
    body = "\n\n".join(o['text'] for o in ordered)
    title = {'translate': '中文译文（本地初稿）', 'summarize': '中文要点（本地初稿）'}[args.mode]
    (outdir / f"{stem}.{args.mode}.md").write_text(f"# {stem} · {title}\n\n{body}\n", encoding='utf-8')

    tot_ct = sum(o['ct'] for o in ordered); tot_sec = sum(o['sec'] for o in ordered)
    flagged = [o for o in ordered if o.get('issues')]
    bad = [o for o in ordered if o.get('qa', {}).get('判定') in ('存疑', '失败')]
    rep = [f"# 流水线报告 · {stem}", "",
           f"- 模式：{args.mode}    范围：{args.pages or '全本'}",
           f"- 提取：{len(paras)} 段 / {sum(len(x['text']) for x in paras)} 字符 -> {len(chunks)} 块",
           f"- 模型：{role['model']}（全量 GPU offload，8192 上下文）",
           f"- 输出：{tot_ct} tokens，耗时 {tot_sec/60:.1f} 分钟，平均 {tot_ct/max(tot_sec,.1):.1f} token/s",
           f"- 机械检查报警：{len(flagged)} 块", f"- 模型复核存疑/失败：{len(bad)} 块", ""]
    if flagged or bad:
        rep += ["## 需要人工看的块", ""]
        for o in ordered:
            tag = []
            if o.get('issues'): tag.append('；'.join(o['issues']))
            if o.get('qa', {}).get('判定') in ('存疑', '失败'):
                tag.append('复核：' + o['qa'].get('理由', ''))
            if tag:
                rep += [f"### 块 {o['i']+1}（{o['src_len']} 字）", "",
                        *[f"- {t}" for t in tag], "",
                        "<details><summary>译文片段</summary>", "",
                        o['text'][:400] + ('…' if len(o['text']) > 400 else ''), "", "</details>", ""]
    (outdir / f"{stem}.{args.mode}.报告.md").write_text("\n".join(rep), encoding='utf-8')

    log(f"完成。产出目录: {outdir}")
    if not args.keep_loaded:
        lms('unload', role['model'])
        log("模型已卸载，显存释放")
    return 0


if __name__ == '__main__':
    sys.exit(main())
