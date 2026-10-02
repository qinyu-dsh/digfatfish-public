#!/usr/bin/env bash
# 下载操作手册的机器版:先探通道 -> 选最快的 -> 全量下 -> 对官方 hash -> 解压
set -u
T="D:/dhs01/tools"; cd "$T" || exit 1
P="probe.bin"

echo "== 1) 元数据(api.github.com) =="
curl -sSL -m 20 -o rel.json https://api.github.com/repos/cli/cli/releases/latest || { echo "  ✗ API 不通"; exit 1; }
VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('D:/dhs01/tools/rel.json','utf8')).tag_name.replace('v',''))")
ZIP="gh_$VER""_windows_amd64.zip"
SUM="gh_$VER""_checksums.txt"
BASE="https://github.com/cli/cli/releases/download/v$VER"
echo "  版本=$VER  资产=$ZIP"

echo "== 2) 探通道(拉前 1MB 测速) =="
pick_name=""; pick_base=""
for c in "直连|$BASE" "gh-proxy.com|https://gh-proxy.com/$BASE" "ghproxy.net|https://ghproxy.net/$BASE"; do
  name=$(echo "$c" | cut -d'|' -f1); base=$(echo "$c" | cut -d'|' -f2)
  out=$(curl -sSL -m 12 --connect-timeout 6 -r 0-1048575 -o "$P" -w "%{http_code}|%{size_download}|%{speed_download}" "$base/$ZIP" 2>/dev/null)
  rc=$?
  if [ $rc -ne 0 ] || [ -z "$out" ]; then printf "  %-14s ❌ rc=%s 放弃\n" "$name" "$rc"; continue; fi
  code=$(echo "$out" | cut -d'|' -f1); sz=$(echo "$out" | cut -d'|' -f2); sp=$(echo "$out" | cut -d'|' -f3)
  kbs=$(awk "BEGIN{printf \"%.0f\", $sp/1024}")
  printf "  %-14s HTTP %s  %s KB  平均 %s KB/s\n" "$name" "$code" "$(awk "BEGIN{printf \"%.0f\", $sz/1024}")" "$kbs"
  if [ "$code" = "206" ] || [ "$code" = "200" ]; then
    if [ -z "$pick_name" ] && [ "$sp" -gt 102400 ]; then pick_name="$name"; pick_base="$base"; fi
  fi
done
[ -z "$pick_name" ] && { echo "  ✗ 没有可用通道"; exit 1; }
echo "  → 选中: $pick_name"

echo "== 3) 全量下载 =="
curl -sSL -m 300 -o gh.zip -w "  http=%{http_code} 大小=%{size_download}B 平均=%{speed_download}B/s 用时=%{time_total}s\n" "$pick_base/$ZIP" || exit 1
ls -la gh.zip | awk '{print "  落盘:", $5, "字节"}'

echo "== 4) 官方 checksums 校验 =="
curl -sSL -m 60 -o sums.txt "$pick_base/$SUM" 2>/dev/null
node -e "
const fs=require('fs'),crypto=require('crypto');
let want='';
try{ const l=(fs.readFileSync('D:/dhs01/tools/sums.txt','utf8').split(/\r?\n/).find(x=>x.indexOf('windows_amd64.zip')>=0)||''); want=l.trim().split(/\s+/)[0]; }catch(e){}
if(!want){ console.log('  ⚠ 没拿到官方 checksums,只能报实测值'); }
const got=crypto.createHash('sha256').update(fs.readFileSync('D:/dhs01/tools/gh.zip')).digest('hex');
console.log('  实测 SHA256:', got);
if(want) console.log(want===got ? '  ✅ 与官方一致' : '  ❌ 与官方不一致('+want+'),停!');
"
echo "== 5) 解压 + 试跑 =="
rm -rf gh && mkdir -p gh && cd gh && unzip -q ../gh.zip || exit 1
H=$(find . -name gh.exe | head -1)
echo "  exe: $H"
"$H" --version 2>&1 | head -2 | sed 's/^/  /'
rm -f "$P"
