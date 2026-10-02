#!/usr/bin/env bash
export MSYS_NO_PATHCONV=1
T="D:/dhs01/tools"; GH="$T/gh/bin/gh.exe"; D="$T/demo"; mkdir -p "$D"; cd "$D" || exit 1
rm -f * 2>/dev/null

echo "===== 演示 A:认证下 release 资产 + 官方 hash 校验 ====="
S=$(date +%s)
"$GH" release download -R cli/cli -p "*windows_amd64.zip" -p "*checksums.txt" -D "$D" --clobber 2>&1 | head -3 | sed 's/^/  /'
E=$(date +%s); echo "  耗时 $((E-S)) 秒"
ls -la | tail -n +2 | awk '{printf "  %s %s\n", $5, $9}'
node -e "
const fs=require('fs'),crypto=require('crypto');
const zip=fs.readdirSync('D:/dhs01/tools/demo').find(f=>/windows_amd64.zip$/.test(f));
const sum=fs.readdirSync('D:/dhs01/tools/demo').find(f=>/checksums[.]txt$/.test(f));
const want=(fs.readFileSync('D:/dhs01/tools/demo/'+sum,'utf8').split(/\r?\n/).find(l=>l.indexOf(zip.replace(/^gh_[0-9.]+_/,''))>=0)||'').trim().split(/\s+/)[0];
const got=crypto.createHash('sha256').update(fs.readFileSync('D:/dhs01/tools/demo/'+zip)).digest('hex');
console.log('  官方:', want || '(没匹配到条目)');
console.log('  实测:', got);
console.log(want===got ? '  == 一致,认证下载完成' : '  == 不一致!');
"

echo "===== 演示 B:整仓库 zipball(绕开被掐的 git clone) ====="
S=$(date +%s)
"$GH" api repos/octocat/Hello-World/zipball > hw.zip 2>/dev/null
E=$(date +%s); echo "  耗时 $((E-S)) 秒"
ls -la hw.zip | awk '{print "  zipball:", $5, "字节"}'
rm -rf hwx && mkdir hwx && cd hwx && unzip -q ../hw.zip && ls | head -3 | sed 's/^/  解出: /' ; cd "$D"

echo "===== 演示 C:采购视图(先查注册表,再看仓库体检) ====="
curl -sS -m 15 "https://registry.modelcontextprotocol.io/v0/servers?limit=50" -o mcp.json -w "  注册表 http=%{http_code}\n"
node -e "
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('D:/dhs01/tools/demo/mcp.json','utf8'));
const list=(j.servers||j.data||[]).map(s=>{const o=s.server||s;return {name:o.name,desc:(o.description||'').slice(0,60),repo:o.repository&&(o.repository.url||o.repository)};}).filter(x=>x.name);
console.log('  注册表里共', (j.servers||j.data||[]).length, '个 MCP 服务,前 3 个:');
for(const x of list.slice(0,3)) console.log('   -', x.name, '|', x.desc, '|', x.repo||'');
fs.writeFileSync('D:/dhs01/tools/demo/pick.txt', (list[0]&&list[0].repo)||'');
"
REPO=$(cat pick.txt | sed 's|https://github.com/||; s|/$||')
if [ -n "$REPO" ]; then
  echo "  体检第一个: $REPO"
  "$GH" api "repos/$REPO" --jq '"   stars=" + (.stargazers_count|tostring) + " size=" + (.size|tostring) + "KB lang=" + (.language//"?") + " pushed=" + (.pushed_at|tostring)' 2>&1 | head -2 | sed 's/^/  /'
  "$GH" api "repos/$REPO/releases/latest" --jq '"   最新发布: " + (.tag_name//"无") + "  资产数 " + ((.assets|length)|tostring)' 2>&1 | head -2 | sed 's/^/  /'
fi
