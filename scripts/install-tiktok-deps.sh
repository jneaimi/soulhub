#!/usr/bin/env bash
# Soul Hub — Optional: install TikTok transcription dependencies (ADR-024).
#
# Idempotent. Safe to re-run. Skips already-installed deps.
#
# Installs:
#   - yt-dlp                 (TikTok metadata + audio download)
#   - ffmpeg                 (resample to 16kHz mono WAV)
#   - whisper.cpp + whisper-cli  (local STT)
#   - curl-cffi (Python pkg) (yt-dlp impersonation backend, improves TikTok reliability)
#   - ggml-base.bin model    (~142 MB, English-default whisper model) → ~/.cache/whisper-cpp/
#
# Optional Arabic-quality model:
#   - ggml-small.bin         (~466 MB) — install with --with-arabic
#
# Disk footprint: ~250 MB default, ~720 MB with --with-arabic.
# Cost: $0. All deps are free + local.

set -euo pipefail

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YLW=$(printf '\033[33m'); BLU=$(printf '\033[34m')
  RST=$(printf '\033[0m')
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; BLU=""; RST=""
fi

step() { printf "%s==>%s %s\n" "$BLU$BOLD" "$RST" "$1"; }
ok()   { printf "  %s✓%s %s\n"   "$GRN" "$RST" "$1"; }
warn() { printf "  %s!%s %s\n"   "$YLW" "$RST" "$1"; }
err()  { printf "  %s✗%s %s\n"   "$RED" "$RST" "$1" >&2; }
die()  { err "$1"; exit 1; }

WITH_ARABIC=0
for arg in "$@"; do
  case "$arg" in
    --with-arabic) WITH_ARABIC=1 ;;
    --help|-h)
      printf "Usage: %s [--with-arabic]\n\n" "$0"
      printf "  --with-arabic   Also download ggml-small.bin (~466 MB) for Arabic STT.\n"
      exit 0
      ;;
  esac
done

OS=$(uname -s)
WHISPER_DIR="${WHISPER_MODEL_BASE_DIR:-$HOME/.cache/whisper-cpp}"
MODEL_BASE="$WHISPER_DIR/ggml-base.bin"
MODEL_SMALL="$WHISPER_DIR/ggml-small.bin"
HF_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

mkdir -p "$WHISPER_DIR"

printf "%sSoul Hub — TikTok transcription deps%s\n" "$BOLD" "$RST"
printf "%sPlatform:%s %s\n\n" "$DIM" "$RST" "$OS"

install_macos() {
  step "Checking Homebrew"
  if ! command -v brew >/dev/null 2>&1; then
    die "Homebrew not found. Install it from https://brew.sh and re-run."
  fi
  ok "brew $(brew --version | head -1 | awk '{print $2}')"

  for pkg in yt-dlp ffmpeg whisper-cpp; do
    step "Installing $pkg"
    if brew list --formula 2>/dev/null | grep -qx "$pkg"; then
      ok "$pkg (already installed)"
    else
      brew install "$pkg"
      ok "$pkg"
    fi
  done
}

install_linux() {
  if ! command -v apt >/dev/null 2>&1 && ! command -v apt-get >/dev/null 2>&1; then
    die "This script only handles Debian/Ubuntu (apt). For other distros install yt-dlp, ffmpeg, whisper.cpp manually."
  fi
  step "Installing yt-dlp + ffmpeg (apt)"
  sudo apt-get update -qq
  sudo apt-get install -y -qq yt-dlp ffmpeg
  ok "yt-dlp + ffmpeg"

  step "Building whisper.cpp from source"
  if command -v whisper-cli >/dev/null 2>&1; then
    ok "whisper-cli (already on PATH)"
  else
    sudo apt-get install -y -qq build-essential cmake git
    BUILD_DIR="${TMPDIR:-/tmp}/whisper-cpp-build"
    rm -rf "$BUILD_DIR"
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$BUILD_DIR" >/dev/null 2>&1
    (cd "$BUILD_DIR" && cmake -B build -DGGML_NATIVE=ON >/dev/null && cmake --build build --target whisper-cli -j 2>&1 | tail -5)
    sudo install -m755 "$BUILD_DIR/build/bin/whisper-cli" /usr/local/bin/whisper-cli
    rm -rf "$BUILD_DIR"
    ok "whisper-cli (built + installed to /usr/local/bin)"
  fi
}

case "$OS" in
  Darwin) install_macos ;;
  Linux)  install_linux ;;
  *) die "Unsupported platform: $OS. Install yt-dlp, ffmpeg, whisper-cpp manually." ;;
esac

step "Installing curl_cffi (Python — yt-dlp impersonation backend)"
# yt-dlp on macOS Homebrew uses its own bundled Python venv (not system
# python3), so a `pip3 --user` install is invisible to it. We resolve the
# shebang of the yt-dlp script and install into THAT interpreter's
# site-packages. Also pin to <0.14 — yt-dlp 2026.03.17 logs curl_cffi 0.15
# as "(unsupported)" and refuses to use --impersonate. Validated 2026-05-10.
CURL_CFFI_PIN='curl_cffi>=0.7,<0.14'
CURL_CFFI_VERSION_OK_PY='import sys, curl_cffi; v = curl_cffi.__version__; major, minor, *_ = v.split("."); ok = (major == "0" and 7 <= int(minor) < 14); sys.exit(0 if ok else 1)'

YTDLP_PY=""
if command -v yt-dlp >/dev/null 2>&1; then
  YTDLP_BIN=$(command -v yt-dlp)
  YTDLP_FIRST_LINE=$(head -1 "$YTDLP_BIN" 2>/dev/null || true)
  if [[ "$YTDLP_FIRST_LINE" == "#!"* ]]; then
    candidate="${YTDLP_FIRST_LINE#\#!}"
    # Strip leading whitespace and trailing args (e.g. `#!/usr/bin/env python3`)
    candidate=$(echo "$candidate" | awk '{print $1}')
    if [ -x "$candidate" ]; then
      YTDLP_PY="$candidate"
    fi
  fi
fi

if [ -n "$YTDLP_PY" ]; then
  if "$YTDLP_PY" -c "$CURL_CFFI_VERSION_OK_PY" >/dev/null 2>&1; then
    ok "curl_cffi (already installed in yt-dlp's venv at compatible version)"
  else
    if "$YTDLP_PY" -m pip install --quiet "$CURL_CFFI_PIN" 2>/dev/null; then
      ok "curl_cffi (installed into yt-dlp's venv)"
    else
      warn "curl_cffi install into yt-dlp's venv failed — TikTok still works but is anti-bot-fragile."
      warn "Manual: $YTDLP_PY -m pip install '$CURL_CFFI_PIN'"
    fi
  fi
else
  # Linux / non-Homebrew install — fall back to system python3
  if python3 -c "$CURL_CFFI_VERSION_OK_PY" >/dev/null 2>&1; then
    ok "curl_cffi (system python3, compatible version)"
  else
    if pip3 install --user --quiet "$CURL_CFFI_PIN" 2>/dev/null; then
      ok "curl_cffi (system python3, --user)"
    else
      warn "curl_cffi install failed — TikTok still works but is anti-bot-fragile."
      warn "Manual: pip3 install --user '$CURL_CFFI_PIN'"
    fi
  fi
fi

# Verify yt-dlp can actually USE --impersonate (catches version-mismatch cases
# where curl_cffi installed but wrong version).
if yt-dlp --list-impersonate-targets 2>/dev/null | grep -qE '^[A-Za-z][[:alnum:]-]*[[:space:]]+[^[:space:]]+[[:space:]]+curl_cffi[[:space:]]*$'; then
  ok "yt-dlp --impersonate works (anti-bot bypass active)"
else
  warn "yt-dlp does NOT see usable impersonate targets — anti-bot bypass inactive."
  warn "Run: yt-dlp --list-impersonate-targets   to inspect."
fi

download_model() {
  local label="$1" path="$2" url="$3"
  step "Whisper model: $label"
  if [ -f "$path" ] && [ "$(wc -c < "$path")" -gt 1000000 ]; then
    ok "$label (already at $path)"
  else
    if command -v curl >/dev/null 2>&1; then
      curl -L --fail --progress-bar -o "$path.tmp" "$url"
    elif command -v wget >/dev/null 2>&1; then
      wget --show-progress -O "$path.tmp" "$url"
    else
      die "Need curl or wget to download whisper models."
    fi
    mv "$path.tmp" "$path"
    ok "$label → $path ($(du -h "$path" | awk '{print $1}'))"
  fi
}

download_model "ggml-base.bin (English default, ~142 MB)" "$MODEL_BASE" "$HF_BASE/ggml-base.bin"

if [ "$WITH_ARABIC" = "1" ]; then
  download_model "ggml-small.bin (Arabic + multilingual, ~466 MB)" "$MODEL_SMALL" "$HF_BASE/ggml-small.bin"
fi

echo
printf "%sTikTok transcription deps installed.%s\n\n" "$GRN$BOLD" "$RST"
printf "Verify: %snpm run doctor%s — look for the %stiktok-fetch deps%s row.\n" "$BOLD" "$RST" "$BOLD" "$RST"
printf "Use:    paste a TikTok URL into WhatsApp/Telegram and ask \"what does this say?\".\n\n"
