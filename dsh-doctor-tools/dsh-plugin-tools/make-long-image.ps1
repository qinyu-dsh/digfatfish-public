Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 900, 700
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Microsoft YaHei', 20)
$brush = [System.Drawing.Brushes]::Black
$lines = @(
  'RimTalk 依赖于: Interaction Bubbles',
  'RimTalk-超凡化身 依赖于: RimTalk',
  'RimTalk 语音扩展 依赖于: RimTalk',
  'RimTalk - Expand Literature 依赖于: RimTalk',
  'Rimtalk中文换行补丁 依赖于: RimTalk, Harmony',
  'RimTalk (边缘世谭) 简繁中文汉化 依赖于: RimTalk',
  'RimTalk 三字母优化 依赖于: Harmony',
  'RimTalk - Expand Memory 依赖于: Harmony, RimTalk',
  'RimTalk: Persona Director 依赖于: Harmony, RimTalk',
  'RimTalk - 内容过滤 依赖于: RimTalk',
  'RimTalk - Enhanced Prompt 依赖于: Harmony, RimTalk',
  'RimTalk Event+ 依赖于: Harmony, RimTalk'
)
for ($i = 0; $i -lt $lines.Count; $i++) {
  $g.DrawString($lines[$i], $font, $brush, 20, 20 + $i * 52)
}
$g.Dispose()
$b.Save('D:\dhs01\dsh-plugin-tools\vision-long.png', [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
'long test image written'
