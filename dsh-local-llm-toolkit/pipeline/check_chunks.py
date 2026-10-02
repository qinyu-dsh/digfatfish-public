"""检查流水线产出的每块长度比，揪出可能漏译的块
用法: python check_chunks.py <chunks.jsonl> [起始序号] [数量]
"""
import sys, json

sys.stdout.reconfigure(encoding='utf-8')
path = sys.argv[1]
start = int(sys.argv[2]) if len(sys.argv) > 2 else 0
n = int(sys.argv[3]) if len(sys.argv) > 3 else 6

rows = []
for line in open(path, encoding='utf-8'):
    if line.strip():
        rows.append(json.loads(line))

print(f"共 {len(rows)} 块已完成\n")
print(f"{'块':>4} {'源字符':>7} {'译字符':>7} {'字符比':>7} {'出tok':>6} {'秒':>6}  问题")
for o in rows[:200]:
    src_len = o.get('src_len') or 1
    ratio = len(o['text']) / src_len
    flag = '; '.join(o.get('issues', []))
    print(f"{o['i']+1:>4} {src_len:>7} {len(o['text']):>7} {ratio:>7.2f} "
          f"{o['ct']:>6} {o['sec']:>6}  {flag}")

if start:
    for o in rows[start - 1:start - 1 + n]:
        print("\n" + "=" * 70)
        print(f"块 {o['i']+1}  源 {o['src_len']} 字符 -> 译 {len(o['text'])} 字符")
        print("---- 译文 ----")
        print(o['text'][:1200])
