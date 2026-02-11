#!/bin/sh
set -e

# Fix permissions for mounted volumes
chown -R jimeng:nodejs /app/logs /app/tmp /app/data 2>/dev/null || true

# Switch to jimeng user and execute the command
exec su-exec jimeng "$@"
