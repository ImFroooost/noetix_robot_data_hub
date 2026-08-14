# Noetix Robot Data Hub

人体动捕 + 机器人重定向 + 维度仓库管理平台（局域网多用户）。

> 2026-08-14 从磁盘挂载事故中重建：后端取自当时仍在运行的 Docker 镜像（约 7 月 31 日），前端由 7 月 29 日快照 + 对话记录中的最终稿拼回。上传数据与原数据库未能恢复。

## 功能

- 动作条目：大类 / 子类 / 语言概括 / 详细描述 / 标签 / 时长
- 人体动捕：同一条目可挂多种格式（bvh / smpl / csv / fbx / npz …），质量高中低
- 机器人数据：按型号与阶段（重定向 / 精修 / refine / 真机）挂载，可缺省、可随时扩充
- 帧率可不同，时长对齐（容差可配）
- 关键词 + 多条件检索，浏览器 3D 可视化（人体骨架 / BVH + URDF 机器人）
- 角色：管理员 / 编辑者 / 只读；JWT 登录；写操作审计

## 快速启动（Docker）

需要已安装 Docker，以及 Compose 插件（`docker compose`）或独立二进制 `docker-compose`。

```bash
cd /media/noetix/my_passport/noetix_robot_data_hub
# 一键启动（自动复制 .env、创建数据目录、构建并启动）
./scripts/start.sh

# 或手动：
cp .env.example .env
docker compose up -d --build   # 或 docker-compose up -d --build
```

- 网页：`http://<服务器IP>/`（默认端口见 `.env` 的 `WEB_PORT`，默认 80）
- API / OpenAPI：`http://<服务器IP>:18000/docs`（见 `.env` 的 `API_PORT`）
- 默认管理员：`admin` / `admin123`（请立刻修改）

数据文件目录：`./data/files`  
维度仓库：`./data/hub_repo`  
数据库目录：`./data/pgdata`

## 使用流程

1. 管理员登录 →「用户管理」创建编辑者账号  
2. 「机器人型号」上传含 URDF + mesh 的 zip  
3. 「上传」创建动作条目并上传人体/机器人文件，或稍后在详情页补充  
4. 「检索」用关键词与筛选查找，进入详情编辑质量/元数据并可视化对比各阶段

## 脚本批量导入

```bash
export API=http://localhost:8000
export USER=admin PASS=your_password
python3 scripts/import_example.py
```

也可调用 `POST /api/import/batch`：把文件放到服务器 `data/files/import/`，清单中的路径相对该目录。

### 交互接口摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录拿 JWT |
| POST | `/api/clips` | 创建条目 |
| PATCH | `/api/clips/{id}` | 编辑元数据 |
| POST | `/api/clips/{id}/human-files` | multipart 上传人体文件（字段：format, quality, file） |
| POST | `/api/clips/{id}/robot-files` | multipart 上传机器人文件（robot_model_id, stage, format, quality, file） |
| PATCH | `/api/clips/human-files/{id}` | 改人体质量等 |
| PATCH | `/api/clips/robot-files/{id}` | 改机器人质量/阶段等 |
| GET | `/api/clips/search` | 关键词 + 筛选检索 |
| POST | `/api/robot-models` | 上传机器人 URDF zip |
| POST | `/api/import/batch` | 批量导入 |

机器人阶段枚举：`retarget` / `polish` / `refine` / `real`  
质量枚举：`high` / `medium` / `low`

## 本地开发（可选）

```bash
# 后端（需本机 postgres + redis，或只起依赖容器）
docker compose up -d db redis
cd backend && pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg2://motion:motion_pass@localhost:5432/motion
export REDIS_URL=redis://localhost:6379/0
export DATA_ROOT=../data/files
uvicorn app.main:app --reload --port 8000

# worker
rq worker motion --url redis://localhost:6379/0

# 前端
cd frontend && npm install && npm run dev
```

## 架构

`web(nginx+React)` → `api(FastAPI)` → `PostgreSQL` + `文件盘`  
上传后 `Redis/RQ worker` 解析帧率/时长、生成预览 JSON 与缩略图。
