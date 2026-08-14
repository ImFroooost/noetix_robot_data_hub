#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "已创建 .env，请按需修改 ADMIN_PASSWORD / SECRET_KEY"
fi

mkdir -p data/files/{human,robot,previews,thumbnails,robot_models,import} data/pgdata data/hub_repo

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "未找到 docker compose 插件。"
  echo "请安装: sudo apt install docker-compose-plugin"
  echo "或: https://docs.docker.com/compose/install/"
  exit 1
fi

$COMPOSE up -d --build
echo ""
echo "网页:  http://$(hostname -I | awk '{print $1}'):${WEB_PORT:-80}/"
echo "API:   http://$(hostname -I | awk '{print $1}'):${API_PORT:-8000}/docs"
echo "默认账号见 .env（ADMIN_USERNAME / ADMIN_PASSWORD）"
