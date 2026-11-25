"""Pack one robot clip's skeleton CSV, object CSV and object XML into a zip.

Meshes stay in the 3D model library. The archive layout is::

    skeleton/<name>.csv
    object/<name>.csv
    object/<name>.xml
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

HUB = Path(__file__).resolve().parents[2] / "data" / "hub_repo"
STYLES = ("noetix_e1", "noetix_e2", "noetix_e2v2_1015", "noetix_m5_0", "unitree_g1")


def style_urdf_name(style: str) -> str:
    folder = HUB / "3d_model" / "robot" / "standard_description" / style / "urdf"
    named = [path for path in folder.glob(f"{style}*.urdf") if path.is_file()]
    dof = [path for path in named if "dof" in path.name]
    chosen = sorted(dof or named or folder.glob("*.urdf"))
    if not chosen:
        raise FileNotFoundError(f"{style} 没有 URDF")
    return chosen[0].name


def export_batch(batch: str, annotations: dict) -> list[dict]:
    written: list[dict] = []
    for style in STYLES:
        urdf_name = style_urdf_name(style)
        csv_dir = HUB / "data" / "robot" / style / "motion" / "omniretarget" / "skeleton" / "csv" / batch
        if not csv_dir.is_dir():
            continue
        for robot_csv in sorted(csv_dir.glob("*.csv")):
            xml_path = (
                HUB / "data" / "robot" / style / "motion" / "omniretarget" / "object" / "xml" / batch / f"{robot_csv.stem}.xml"
            )
            object_csv = (
                HUB / "data" / "robot" / style / "motion" / "omniretarget" / "object" / "csv" / batch / f"{robot_csv.stem}.csv"
            )
            if not xml_path.is_file() or not object_csv.is_file():
                continue
            output = (
                HUB / "data" / "robot" / style / "motion" / "omniretarget" / "merged" / "zip" / batch / f"{robot_csv.stem}.zip"
            )
            output.parent.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(robot_csv, f"skeleton/{robot_csv.name}")
                archive.write(object_csv, f"object/{object_csv.name}")
                archive.write(xml_path, f"object/{xml_path.name}")
            rel_csv = robot_csv.relative_to(HUB).as_posix()
            previous = (annotations.get(rel_csv) or {}).get("annotation") or {}
            world = previous.get("world_frame") or ""
            annotation = {
                "motion_kind": "merged",
                "robot_style": style,
                "robot_version": previous.get("robot_version") or f"urdf/{urdf_name}",
                "robot_model_id": previous.get("robot_model_id") or f"robot/{style}/{Path(urdf_name).stem}",
                "fps": 30,
                "note": "机器人合并数据打包：skeleton/*.csv、object/*.csv、object/*.xml。网格在 3D 模型库。",
            }
            if world:
                annotation["world_frame"] = world
            written.append({"path": output.relative_to(HUB).as_posix(), "annotation": annotation})
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Pack robot skeleton and object files into zip.")
    parser.add_argument("--batch", default="260317_parkour")
    parser.add_argument("--manifest", type=Path, default=HUB / "index" / "_robot_hoi_zip_ann.json")
    args = parser.parse_args()
    catalog = json.loads((HUB / "index" / "repository.json").read_text(encoding="utf-8"))
    written = export_batch(args.batch, catalog.get("files") or {})
    args.manifest.write_text(json.dumps(written, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(written)} zip, manifest {args.manifest}")


if __name__ == "__main__":
    main()
