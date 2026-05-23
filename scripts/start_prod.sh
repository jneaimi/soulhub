#!/bin/bash
# Soul Hub V2 — Production starter (PM2)
# Usage: ./scripts/start_prod.sh [start|stop|restart|status|logs|startup]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.soul-hub/logs"

mkdir -p "$LOG_DIR"

cd "$SCRIPT_DIR"

case "${1:-start}" in
    start)
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
        echo "Configuring PM2 boot persistence..."
        npx pm2 startup
        npx pm2 save
        echo "PM2 will now auto-start on boot."
        ;;
    *)
        echo "Usage: $0 [start|stop|restart|status|logs|startup]"
        exit 1
        ;;
esac
