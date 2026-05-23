# Soul Hub bootstrap — Windows.
# Soul Hub does not run natively on Windows. This script detects WSL2
# and forwards the install into the Linux environment, where everything
# (PTY, shells, native modules) works correctly.

$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Blue }
function OK($msg)   { Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  $([char]0x2717) $msg" -ForegroundColor Red; exit 1 }

Write-Host "Soul Hub bootstrap (Windows)" -ForegroundColor White
Write-Host ""

# ── 1. Are we running inside WSL already? ────────────────────────
if ($env:WSL_DISTRO_NAME) {
    Warn "You're already inside WSL ($($env:WSL_DISTRO_NAME)). Run scripts/bootstrap.sh instead:"
    Write-Host "    bash scripts/bootstrap.sh"
    exit 0
}

# ── 2. Verify WSL is installed ───────────────────────────────────
Step "Checking for WSL2"
$wslAvailable = $false
try {
    $null = & wsl.exe --status 2>$null
    if ($LASTEXITCODE -eq 0) { $wslAvailable = $true }
} catch { $wslAvailable = $false }

if (-not $wslAvailable) {
    Die @"
WSL2 is not installed.

Soul Hub uses node-pty, POSIX shells, and native binaries that don't run on
Windows directly. The supported path on Windows is WSL2 (Ubuntu).

Install WSL2:
  1. Open PowerShell as Administrator
  2. Run:  wsl --install -d Ubuntu
  3. Restart Windows when prompted
  4. Open the Ubuntu app, finish first-run setup
  5. From inside Ubuntu, re-clone Soul Hub into your Linux home:
       cd ~ && git clone https://github.com/jneaimi/soul-hub.git
       cd soul-hub && bash scripts/bootstrap.sh

Do NOT clone the repo into /mnt/c/... — file watching is unreliable
across the WSL/Windows filesystem boundary. Keep everything in /home/<user>.
"@
}
OK "WSL2 detected"

# ── 3. Verify a default distro exists ────────────────────────────
Step "Checking default WSL distro"
$distros = & wsl.exe -l -q 2>$null
if (-not $distros -or $distros.Count -eq 0) {
    Die "No WSL distro installed. Run:  wsl --install -d Ubuntu"
}
$defaultDistro = ($distros | Where-Object { $_.Trim() })[0].Trim()
OK "Default distro: $defaultDistro"

# ── 4. Tell the user the right next move ─────────────────────────
Write-Host ""
Write-Host "Soul Hub must run from inside WSL, not from Windows." -ForegroundColor Yellow
Write-Host ""
Write-Host "Recommended setup:" -ForegroundColor White
Write-Host "  1. Open Ubuntu (Start menu -> Ubuntu, or  wsl  in this terminal)"
Write-Host "  2. Inside Ubuntu, clone the repo into your Linux home:"
Write-Host "       cd ~"
Write-Host "       git clone https://github.com/jneaimi/soul-hub.git"
Write-Host "       cd soul-hub"
Write-Host "       bash scripts/bootstrap.sh"
Write-Host ""
Write-Host "  3. Then start it:"
Write-Host "       npm run dev"
Write-Host ""
Write-Host "  Browse to http://localhost:5173 from your Windows browser." -ForegroundColor Green
Write-Host "  WSL2 forwards localhost automatically — no extra config needed." -ForegroundColor Green
Write-Host ""
Write-Host "Why not run from this checkout? You're on /mnt/c — file watching" -ForegroundColor DarkGray
Write-Host "is unreliable there and the install will be 5-10x slower than" -ForegroundColor DarkGray
Write-Host "from the Linux filesystem." -ForegroundColor DarkGray
