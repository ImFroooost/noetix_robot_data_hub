"""Copy holosoma_retargeting robot models into the hub so preview uses the same assets.

Registered styles (unitree_g1, noetix_e1, noetix_e2, noetix_m4_1, noetix_m5_a,
noetix_m5_b, t1) are mirrored into 3d_model/robot/standard_description/<style>/.
The default description file is the URDF holosoma retargets against. Unitree G1
has no URDF in holosoma; its existing URDF is kept because its joint order matches
models/g1/g1_29dof.xml.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

HUB = Path("/media/noetix/my_passport1/noetix_robot_data_hub/data/hub_repo")
HOLO_MODELS = Path(
    "/home/noetix/Desktop/new_home/learning_based/wbc/open_src/omni_retarget/"
    "holosoma/src/holosoma_retargeting/holosoma_retargeting/models"
)

# style on the website -> holosoma asset directory
STYLE_DIR = {
    "unitree_g1": "g1",
    "noetix_e1": "noetix_e1",
    "noetix_e2": "noetix_e2",
    "noetix_m4_1": "noetix_m4_1",
    "noetix_m5_a": "noetix_m5_a",
    "noetix_m5_b": "noetix_m5_b",
    "t1": "t1",
}

DEFAULT_URDF = {
    "unitree_g1": "urdf/g1_custom_collision_29dof.urdf",
    "noetix_e1": "urdf/noetix_e1_24dof.urdf",
    "noetix_e2": "urdf/noetix_e2_23dof.urdf",
    "noetix_m4_1": "urdf/noetix_m4_1_17dof.urdf",
    "noetix_m5_a": "urdf/noetix_m5_a_17dof.urdf",
    "noetix_m5_b": "urdf/noetix_m5_b_17dof.urdf",
    "t1": "urdf/t1_23dof.urdf",
}


def _copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_file() and dst.stat().st_size == src.stat().st_size:
        if dst.read_bytes() == src.read_bytes():
            return
    shutil.copy2(src, dst)


def _sync_tree(src: Path, dst: Path) -> int:
    count = 0
    if not src.is_dir():
        return 0
    for path in src.rglob("*"):
        if not path.is_file() or path.name.startswith("."):
            continue
        rel = path.relative_to(src)
        _copy_file(path, dst / rel)
        count += 1
    return count


def sync() -> None:
    now = datetime.now(timezone.utc).isoformat()
    meta_path = HUB / "index" / "repository.json"
    data = json.loads(meta_path.read_text())
    models = data.setdefault("models", {})
    for style, dirname in STYLE_DIR.items():
        source = HOLO_MODELS / dirname
        if not source.is_dir():
            raise SystemExit(f"缺少 holosoma 模型目录：{source}")
        dest = HUB / "3d_model" / "robot" / "standard_description" / style
        for folder in ("meshes", "mjcf", "urdf"):
            (dest / folder).mkdir(parents=True, exist_ok=True)
        mesh_count = _sync_tree(source / "meshes", dest / "meshes")
        copied = []
        for path in source.iterdir():
            if not path.is_file():
                continue
            if path.suffix.lower() == ".urdf":
                _copy_file(path, dest / "urdf" / path.name)
                copied.append(path.name)
            elif path.suffix.lower() == ".xml" and "scene" not in path.name and "paddle" not in path.name:
                _copy_file(path, dest / "mjcf" / path.name)
                copied.append(path.name)
        row = models.setdefault(f"robot::{style}", {})
        row.setdefault("created_at", now)
        row["description"] = "与 holosoma_retargeting 使用同一套机器人模型"
        default = DEFAULT_URDF[style]
        if (dest / default).is_file():
            row["default_description_file"] = default
        row["updated_at"] = now
        print(f"{style}: meshes {mesh_count}, descriptions {copied or ['(沿用已有 URDF)']}")
    data["version"] = int(data.get("version") or 1) + 1
    data["updated_at"] = now
    tmp = meta_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(meta_path)
    print("模型元数据已更新")


if __name__ == "__main__":
    sync()
