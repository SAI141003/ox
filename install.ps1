# Install ox on Windows from a GitHub release, checked before anything is installed:
#
#   irm https://raw.githubusercontent.com/SAI141003/ox/main/install.ps1 | iex
#   $env:OX_VERSION='v0.1.7'; irm …/install.ps1 | iex     # an exact release
#
# It resolves the release to an exact tag, downloads the zip and its .sha256 from
# it and stops on a mismatch; with the GitHub CLI (gh) it also checks GitHub's
# signed attestation that the zip was built by this repository's release workflow.
# Only then is it unpacked, and the "downloaded" mark cleared on those files only
# (ox is not code-signed for SmartScreen). It does not start OX. For this user
# only: no admin needed.
$ErrorActionPreference = 'Stop'
$repo = 'SAI141003/ox'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw 'ox needs 64-bit Windows' }
$dest = Join-Path $env:LOCALAPPDATA 'ox'
$zip = Join-Path $env:TEMP "ox-windows-$arch.zip"

$tag = $env:OX_VERSION
if (-not $tag) {
  $r = Invoke-WebRequest "https://github.com/$repo/releases/latest" -MaximumRedirection 0 -ErrorAction SilentlyContinue -UseBasicParsing
  $tag = ($r.Headers.Location -replace '.*/tag/', '')
}
if ($tag -notmatch '^v[0-9]') { throw "could not find the release (got '$tag'); set OX_VERSION" }
$base = "https://github.com/$repo/releases/download/$tag"
$name = "ox-windows-$arch.zip"
Write-Host "ox $tag"
Write-Host "downloading $name..."
Invoke-WebRequest "$base/$name" -OutFile $zip -UseBasicParsing
# Saved to a file and read as text: GitHub serves release files as bytes, so .Content would be a byte array.
$sumFile = "$zip.sha256"
try { Invoke-WebRequest "$base/$name.sha256" -OutFile $sumFile -UseBasicParsing; $want = (((Get-Content $sumFile -Raw) -as [string]).Trim() -split '\s+')[0]; Remove-Item $sumFile }
catch { Remove-Item $zip, $sumFile -ErrorAction SilentlyContinue; throw "$tag publishes no checksum for ${name}: not installing an unchecked download" }
if (-not $want) { Remove-Item $zip; throw "the checksum file for ${name} is empty. Nothing was installed." }
$have = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($want.ToLower() -ne $have) { Remove-Item $zip; throw "checksum mismatch for ${name}: expected $want, got $have. Nothing was installed." }
Write-Host "checksum ok: $have"
# gh gives no verdict until it is signed in, which says nothing about the file.
$ghReady = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
  gh auth status *> $null
  if ($LASTEXITCODE -eq 0) { $ghReady = $true } else { Write-Host '  (the GitHub CLI is not signed in: checked the checksum only. gh auth login adds the check of who built it)' }
}
if ($ghReady) {
  gh attestation verify $zip --repo $repo *> $null
  if ($LASTEXITCODE -ne 0) { Remove-Item $zip; throw "GitHub could not confirm $name was built by $repo's release workflow. Nothing was installed." }
  Write-Host "built by $repo's release workflow (GitHub attestation)"
}
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

Write-Host "ox $tag installed in $dest. Open OX from the Start menu when you are ready, or type  ox  in a new terminal." 
