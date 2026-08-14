#!/usr/bin/env python3
"""批量导入示例：创建条目、上传人体/机器人文件、设置质量等级。

用法:
  export API=http://localhost:8000
  export USER=admin PASS=admin123
  python scripts/import_example.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import urllib.request

API = os.environ.get("API", "http://localhost:8000").rstrip("/")
USER = os.environ.get("USER", "admin")
PASS = os.environ.get("PASS", "admin123")


def req(method: str, path: str, token: str | None = None, data=None, files=None):
    url = f"{API}{path}"
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if files is not None:
        # simple multipart
        import uuid

        boundary = f"----Boundary{uuid.uuid4().hex}"
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        parts = []
        for key, value in files.items():
            if isinstance(value, tuple):
                filename, content, content_type = value
                parts.append(
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{key}"; filename="{filename}"\r\n'
                    f"Content-Type: {content_type}\r\n\r\n".encode()
                    + content
                    + b"\r\n"
                )
            else:
                parts.append(
                    (
                        f"--{boundary}\r\n"
                        f'Content-Disposition: form-data; name="{key}"\r\n\r\n'
                        f"{value}\r\n"
                    ).encode()
                )
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request) as resp:
        raw = resp.read()
        if not raw:
            return None
        return json.loads(raw.decode())


def login() -> str:
    out = req("POST", "/api/auth/login", data={"username": USER, "password": PASS})
    return out["access_token"]


def main():
    token = login()
    print("logged in")

    # 1) 创建 clip
    clip = req(
        "POST",
        "/api/clips",
        token,
        data={
            "category": "行走",
            "subcategory": "平地",
            "summary": "示例：向前行走",
            "description": "受试者在平地上自然向前行走约 3 秒。",
            "tags": ["walk", "示例"],
            "duration_sec": 3.0,
        },
    )
    clip_id = clip["id"]
    print("created clip", clip_id)

    # 2) 上传人体 BVH（若提供路径）
    sample_dir = Path(__file__).resolve().parent / "sample_data"
    bvh = sample_dir / "walk.bvh"
    if bvh.is_file():
        content = bvh.read_bytes()
        req(
            "POST",
            f"/api/clips/{clip_id}/human-files",
            token,
            files={
                "format": "bvh",
                "quality": "high",
                "file": (bvh.name, content, "application/octet-stream"),
            },
        )
        print("uploaded human bvh")
    else:
        print("skip human upload: put a file at", bvh)

    # 3) 批量导入 JSON 清单（文件需事先放到服务器 data/files/import/）
    manifest = {
        "copy_files": True,
        "items": [
            {
                "category": "行走",
                "subcategory": "平地",
                "summary": "批量导入示例条目",
                "description": "通过 /api/import/batch 导入",
                "tags": ["batch"],
                "duration_sec": 2.0,
                "human_files": [
                    # {"format": "csv", "path": "demo/human.csv", "quality": "medium"}
                ],
                "robot_files": [
                    # {
                    #   "robot_model": "MyRobot",
                    #   "stage": "retarget",
                    #   "path": "demo/robot.csv",
                    #   "format": "csv",
                    #   "quality": "medium"
                    # }
                ],
            }
        ],
    }
    out = req("POST", "/api/import/batch", token, data=manifest)
    print("batch import:", out)
    print("OpenAPI 文档:", f"{API}/docs")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR:", e, file=sys.stderr)
        sys.exit(1)
