#!/usr/bin/env bash
# get.sh <url> <outfile> [expected-sha256]
# 下载操作手册的机器版:
#   1) 探通道(-r 0-1MB 测速) 2) 按速度排序 3) 逐个通道真下(带重试)
#   4) 校验 sha256 5) 报账(通道/速度/大小/hash)
# 铁律:直连 github.com 会随机 reset/超时 -> 必须带镜像降级;绝不原地死等。
set -u
if [ $# -lt 2 ]; then echo "用法: get.sh <url> <outfile> [sha256]"; exit 2; fi
URL="$1"; OUT="$2"; WANT=""; [ $# -ge 3 ] && WANT="$3"
DIR=$(dirname "$OUT"); mkdir -p "$DIR" || exit 1
PROBE="$DIR/.probe.bin"; LIST="$DIR/.cand.txt"; : > "$LIST"

printf '直连|%s\n' "$URL" >> "$LIST"
case "$URL" in
  https://github.com/*|https://raw.githubusercontent.com/*|https://objects.githubusercontent.com/*|https://codeload.github.com/*)
    P=$(printf '%s' "$URL" | sed 's|^https://||')
    printf 'gh-proxy.com|https://gh-proxy.com/https://%s\n' "$P" >> "$LIST"
    printf 'ghproxy.net|https://ghproxy.net/https://%s\n' "$P" >> "$LIST"
    ;;
  https://nodejs.org/dist/*)
    P=$(printf '%s' "$URL" | sed 's|^https://nodejs.org/dist/||')
    printf 'npmmirror|https://registry.npmmirror.com/-/binary/node/%s\n' "$P" >> "$LIST"
    ;;
esac

echo "[get] $URL"
RANK="$DIR/.rank.txt"; : > "$RANK"
while IFS='|' read -r N U; do
  [ -z "$N" ] && continue
  R=$(curl -sSL -m 12 --connect-timeout 6 -r 0-1048575 -o "$PROBE" -w "%{http_code}|%{size_download}|%{speed_download}" "$U" 2>/dev/null); RC=$?
  if [ $RC -ne 0 ] || [ -z "$R" ]; then printf '  %-13s x (rc=%s)\n' "$N" "$RC"; continue; fi
  C=$(printf '%s' "$R" | cut -d'|' -f1); S=$(printf '%s' "$R" | cut -d'|' -f2); SP=$(printf '%s' "$R" | cut -d'|' -f3)
  printf '  %-13s HTTP %-3s %5s KB  %6s KB/s\n' "$N" "$C" "$(awk "BEGIN{printf \"%.0f\", $S/1024}")" "$(awk "BEGIN{printf \"%.0f\", $SP/1024}")"
  GOOD=0
  if [ "$C" = "200" ] || [ "$C" = "206" ]; then
    GOOD=$(awk -v s="$S" -v sp="$SP" 'BEGIN{ if (s>0 && s<1048576) print 1; else if (sp>61440) print 1; else print 0 }')
  fi
  [ "$GOOD" = "1" ] && printf '%s|%s|%s\n' "$SP" "$N" "$U" >> "$RANK"
done < "$LIST"
rm -f "$PROBE"

if [ ! -s "$RANK" ]; then echo "  x 没有可用通道(不原地重试)"; rm -f "$LIST" "$RANK"; exit 1; fi

OK=0
sort -t'|' -k1,1 -rn "$RANK" | while IFS='|' read -r SP N U; do
  printf '  -> 试 %s 全量下载...\n' "$N"
  R=$(curl -sSL -m 600 --connect-timeout 8 --retry 2 --retry-delay 1 -o "$OUT" -w "%{http_code}|%{size_download}|%{speed_download}|%{time_total}" "$U" 2>/dev/null); RC=$?
  if [ $RC -eq 0 ] && [ -s "$OUT" ]; then
    C=$(printf '%s' "$R" | cut -d'|' -f1); SZ=$(printf '%s' "$R" | cut -d'|' -f2); SPD=$(printf '%s' "$R" | cut -d'|' -f3); TM=$(printf '%s' "$R" | cut -d'|' -f4)
    printf '  == 成功: 通道 %s | HTTP %s | %.2f MB | %.0f KB/s | %ss\n' "$N" "$C" "$(awk "BEGIN{print $SZ/1048576}")" "$(awk "BEGIN{print $SPD/1024}")" "$TM"
    printf '  == 落盘 %s\n' "$OUT"
    GOT=$(node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "$OUT")
    printf '  == SHA256 %s\n' "$GOT"
    if [ -n "$WANT" ]; then
      if [ "$WANT" = "$GOT" ]; then echo "  == 校验: 与期望一致 OK"; else echo "  == 校验: 不一致 (期望 $WANT) FAIL"; fi
    fi
    echo "OK" > "$DIR/.ok"
    break
  fi
  printf '  -- %s 全量失败 rc=%s,换下一条\n' "$N" "$RC"
done
[ -f "$DIR/.ok" ] && rm -f "$DIR/.ok" "$LIST" "$RANK" && exit 0
rm -f "$LIST" "$RANK"; echo "  x 全部通道都失败"; exit 1
