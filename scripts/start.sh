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

API_CONTAINER="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT")}-api-1"
if docker inspect "$API_CONTAINER" >/dev/null 2>&1; then
  CURRENT="$(docker inspect "$API_CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
  if [[ -n "$CURRENT" && "$CURRENT" != "$ROOT" ]]; then
    echo "容器仍绑定旧目录：$CURRENT"
    echo "将按当前项目目录重建：$ROOT"
    $COMPOSE down
  fi
fi

$COMPOSE up -d --build
echo ""
echo "网页:  http://$(hostname -I | awk '{print $1}'):${WEB_PORT:-80}/"
echo "API:   http://$(hostname -I | awk '{print $1}'):${API_PORT:-8000}/docs"
echo "默认账号见 .env（ADMIN_USERNAME / ADMIN_PASSWORD）"
