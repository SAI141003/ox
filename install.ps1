# Install ox on Windows from the latest GitHub release, without SmartScreen's
# "downloaded from the internet" block:
#
#   irm https://raw.githubusercontent.com/SAI141003/ox/main/install.ps1 | iex
#
# Unblock-File clears the mark a download carries; the files are the same ones
# on the release page. Installs for this user only: no admin needed.
$ErrorActionPreference = 'Stop'
$repo = 'SAI141003/ox'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw 'ox needs 64-bit Windows' }
$dest = Join-Path $env:LOCALAPPDATA 'ox'
$zip = Join-Path $env:TEMP "ox-windows-$arch.zip"

Write-Host 'downloading ox for Windows...'
Invoke-WebRequest "https://github.com/$repo/releases/latest/download/ox-windows-$arch.zip" -OutFile $zip -UseBasicParsing
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dest*" } | Stop-Process -Force
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Expand-Archive $zip -DestinationPath $dest -Force
Remove-Item $zip
Get-ChildItem $dest -Recurse -File | Unblock-File

# `ox` in new terminals, and OX in the Start menu.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dest })) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest".TrimStart(';'), 'User')
}
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'OX.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"' + (Join-Path $dest 'OX.vbs') + '"'
$s.WorkingDirectory = $env:USERPROFILE
$s.Save()

Write-Host "ox installed in $dest. Open OX from the Start menu, or type  ox  in a new terminal."
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $dest 'OX.vbs') + '"')
