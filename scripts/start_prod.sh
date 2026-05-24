#!/bin/bash
# Soul Hub V2 — Production starter (PM2)
# Usage: ./scripts/start_prod.sh [start|stop|restart|status|logs|startup]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.soul-hub/logs"

mkdir -p "$LOG_DIR"

cd "$SCRIPT_DIR"

# node-pty opens a pty master/slave pair + a spawn-helper process per terminal
# session. Under macOS launchd's default 256-FD soft limit (`launchctl limit
# maxfiles`), a long-running PM2 daemon eventually runs out and posix_spawn
# fails with the opaque "posix_spawnp failed." — the in-app Terminal returns a
# 422 and node-pty propagates no errno. Interactive shells already get ~1M, but
# a daemon launched at boot inherits 256. Raise the soft limit for the daemon
# we're about to (re)launch. See debugging note 2026-05-24-pty-posix-spawnp.
raise_fd_limit() {
    for n in 65536 32768 10240 4096; do
        if ulimit -n "$n" 2>/dev/null; then
            echo "FD soft limit raised to $(ulimit -n) for the PM2 daemon."
            return 0
        fi
    done
    echo "WARN: could not raise FD soft limit (currently $(ulimit -n)); the in-app Terminal may hit posix_spawnp failures." >&2
}

# Inject SoftResourceLimits/NumberOfFiles into the launchd plist that
# `pm2 startup` generates, so the boot-launched daemon also escapes the 256-FD
# cap (the interactive-shell ulimit above doesn't reach the boot path). macOS
# only; idempotent; best-effort. Reloads the agent if it lives in ~/Library.
patch_pm2_plist_fd_limit() {
    [ "$(uname)" = "Darwin" ] || return 0
    local pb="/usr/libexec/PlistBuddy"
    [ -x "$pb" ] || { echo "WARN: PlistBuddy missing — skipping plist FD-limit patch." >&2; return 0; }

    local plist patched=0
    for plist in "$HOME"/Library/LaunchAgents/pm2.*.plist /Library/LaunchDaemons/pm2.*.plist; do
        [ -f "$plist" ] || continue
        "$pb" -c "Add :SoftResourceLimits dict" "$plist" 2>/dev/null || true
        "$pb" -c "Add :SoftResourceLimits:NumberOfFiles integer 65536" "$plist" 2>/dev/null \
            || "$pb" -c "Set :SoftResourceLimits:NumberOfFiles 65536" "$plist" 2>/dev/null || true
        echo "Patched FD limit into: $plist"
        patched=1
        # User LaunchAgents can be reloaded without sudo; system daemons can't.
        case "$plist" in
            "$HOME"/Library/LaunchAgents/*)
                launchctl unload "$plist" 2>/dev/null || true
                launchctl load "$plist" 2>/dev/null || true
                ;;
        esac
    done
    if [ "$patched" -eq 0 ]; then
        echo "Note: no pm2 launchd plist found to patch (pm2 startup may print a sudo command — run it, then re-run: $0 startup)."
    fi
}

case "${1:-start}" in
    start)
        raise_fd_limit
        echo "Building Soul Hub..."
        npm run build
        echo "Starting via PM2..."
        npx pm2 start ecosystem.config.cjs
        echo ""
        PORT="${PORT:-2400}"
        echo "Soul Hub running at http://localhost:${PORT}"
        npx pm2 status
        ;;
    stop)
        echo "Stopping Soul Hub..."
        npx pm2 stop ecosystem.config.cjs
        npx pm2 status
        ;;
    restart)
        echo "Building Soul Hub..."
        npm run build
        echo "Reloading soul-hub (zero-downtime)..."
        npx pm2 reload soul-hub
        npx pm2 status
        ;;
    status)
        npx pm2 status
        ;;
    logs)
        npx pm2 logs
        ;;
    startup)
        raise_fd_limit
        echo "Configuring PM2 boot persistence..."
        npx pm2 startup
        npx pm2 save
        patch_pm2_plist_fd_limit
        echo "PM2 will now auto-start on boot (with a raised FD limit)."
        ;;
    *)
        echo "Usage: $0 [start|stop|restart|status|logs|startup]"
        exit 1
        ;;
esac
