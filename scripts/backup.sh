#!/usr/bin/env bash
# 备份数据库和标注元数据（不含动作文件本身）。
#
#   ./scripts/backup.sh            # 备份到 $BACKUP_DIR，保留最近 $BACKUP_KEEP 份
#
# 恢复：
#   zstd -dc <份>/postgres.sql.zst | docker exec -i noetix_robot_data_hub-db-1 psql -U motion -d motion
#   zstd -dc <份>/repository.json.zst > data/hub_repo/index/repository.json
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/media/noetix/hdd_raid_10_box/noetix_hub_backups}"
BACKUP_KEEP="${BACKUP_KEEP:-30}"
DB_CONTAINER="${DB_CONTAINER:-$(basename "$ROOT")-db-1}"
INDEX="$ROOT/data/hub_repo/index"

stamp="$(date +%Y%m%d_%H%M%S)"
dest="$BACKUP_DIR/$stamp"
work="$BACKUP_DIR/.partial_$stamp"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

# 数据库：用户、权限、分类树、操作记录
docker exec "$DB_CONTAINER" pg_dump -U motion -d motion --clean --if-exists \
  | zstd -q -T0 -o "$work/postgres.sql.zst"

# 标注元数据。API 用“写临时文件再替换”的方式保存，直接读到的总是完整的一份。
zstd -q -T0 -f "$INDEX/repository.json" -o "$work/repository.json.zst"
zstd -dc "$work/repository.json.zst" | python3 -c 'import json,sys; json.load(sys.stdin)'

# 重定向的设置（优先级、预设等，都很小）
for name in dimensions.json auto_retarget_control.json auto_retarget_priority.json \
            auto_retarget_priority_presets.json auto_retarget_pins.json; do
  if [[ -f "$INDEX/$name" ]]; then cp "$INDEX/$name" "$work/"; fi
done

# 写完整了才改成正式名字，半截的备份不会被当成可用的一份
mv "$work" "$dest"
trap - EXIT

# 只保留最近 BACKUP_KEEP 份
mapfile -t old < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | head -n -"$BACKUP_KEEP")
for dir in "${old[@]}"; do rm -rf "$dir"; done

echo "$(date -Is) 备份完成 $dest（$(du -sh "$dest" | cut -f1)）"
