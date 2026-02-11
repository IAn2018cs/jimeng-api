#!/bin/bash

COMPOSE_FILE="docker-compose.yml"
SERVICE_NAME="jimeng-api"

cd "$(dirname "$0")" || exit 1

case "$1" in
  start)
    echo "启动服务..."
    docker compose -f "$COMPOSE_FILE" up -d --build
    echo "服务已启动"
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  stop)
    echo "停止服务..."
    docker compose -f "$COMPOSE_FILE" down
    echo "服务已停止"
    ;;
  restart)
    echo "重启服务..."
    docker compose -f "$COMPOSE_FILE" down
    docker compose -f "$COMPOSE_FILE" up -d --build
    echo "服务已重启"
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  logs)
    docker compose -f "$COMPOSE_FILE" logs -f --tail=100 "$SERVICE_NAME"
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  *)
    echo "用法: $0 {start|stop|restart|logs|status}"
    exit 1
    ;;
esac
