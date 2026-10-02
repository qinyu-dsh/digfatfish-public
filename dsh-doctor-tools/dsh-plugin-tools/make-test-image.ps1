Add-Type -AssemblyName System.Drawing
$b = New-Object System.Drawing.Bitmap 800, 300
$g = [System.Drawing.Graphics]::FromImage($b)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Arial', 72)
$brush = [System.Drawing.Brushes]::Black
$g.DrawString('HELLO 12345', $font, $brush, 30, 80)
$g.Dispose()
$b.Save('D:\dhs01\dsh-plugin-tools\vision-test.png', [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
'image written'
