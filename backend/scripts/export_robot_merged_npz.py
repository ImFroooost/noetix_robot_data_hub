"""Write a robot HOI clip as one npz, without meshes.

The file is 30 Hz, metres, Z-up, quaternions xyzw. It stores the floating-base
pose, actuated joint angles, and rigid-body or marker trajectories. Robot and
object geometry stay in the 3D model library; boxes keep their size here
because each clip's obstacle is a different box.

Arrays
    meta              uint8 JSON
    robot_root_pos    (frames, 3) float32
    robot_root_quat   (frames, 4) float32, xyzw
    robot_joint_pos   (frames, joints) float32, radians, URDF actuated order
    body_pos          (frames, bodies, 3) float32, omitted when there is no body
    body_quat         (frames, bodies, 4) float32, xyzw; identity for markers
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

HUB = Path("/media/noetix/my_passport1/noetix_robot_data_hub/data/hub_repo")
STYLES = ("noetix_e1", "noetix_e2", "noetix_e2v2_1015", "noetix_m5_0", "unitree_g1")
FPS = 30.0
ACTUATED = {"revolute", "continuous", "prismatic"}
FLOATING = re.compile(
    r"floor_2_base|floating_base|floatingbase|root_joint|base_joint|world_to_",
    re.IGNORECASE,
)


def actuated_joints(urdf_path: Path) -> list[str]:
    root = ET.parse(urdf_path).getroot()
    names: list[str] = []
    for joint in root.iter("joint"):
        name = joint.get("name") or ""
        kind = (joint.get("type") or "").lower()
        if kind not in ACTUATED or not name or FLOATING.search(name):
            continue
        names.append(name)
    return names


def style_urdf(style: str) -> Path:
    folder = HUB / "3d_model" / "robot" / "standard_description" / style / "urdf"
    named = [path for path in folder.glob(f"{style}*.urdf") if path.is_file()]
    dof = [path for path in named if "dof" in path.name]
    chosen = sorted(dof or named)
    if chosen:
        return chosen[0]
    any_urdf = sorted(path for path in folder.glob("*.urdf") if path.is_file())
    if not any_urdf:
        raise FileNotFoundError(f"{style} 没有 URDF")
    return any_urdf[0]


def read_robot_csv(path: Path) -> np.ndarray:
    rows: list[list[float]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        rows.append([float(item) for item in line.split(",")])
    if not rows:
        raise ValueError(f"骨架 CSV 为空：{path}")
    return np.asarray(rows, dtype=np.float64)


def read_object_csv(path: Path) -> tuple[list[str], np.ndarray]:
    lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    header = lines[0].split(",")
    rows = [[float(item) for item in line.split(",")] for line in lines[1:]]
    if not rows:
        raise ValueError(f"物体 CSV 为空：{path}")
    return header, np.asarray(rows, dtype=np.float64)


def scene_bodies(xml_path: Path) -> list[dict]:
    root = ET.parse(xml_path).getroot()
    bodies: list[dict] = []
    for body in root.findall("body"):
        body_id = body.get("id") or body.get("name") or ""
        if not body_id:
            continue
        kind = "marker" if body.get("kind") == "marker" else "rigid"
        points = [
            (
                float(node.get("x") or 0),
                float(node.get("y") or 0),
                float(node.get("z") or 0),
            )
            for node in body.findall("vertices/v")
        ]
        if kind == "marker" or len(points) < 3:
            bodies.append(
                {
                    "id": body_id,
                    "kind": "marker",
                    "model_id": "object/marker_sphere",
                    "radius_m": 0.02,
                }
            )
            continue
        arr = np.asarray(points, dtype=np.float64)
        low = arr.min(axis=0)
        high = arr.max(axis=0)
        bodies.append(
            {
                "id": body_id,
                "kind": "rigid",
                "model_id": "object/unit_box",
                "shape": "box",
                "size_m": [float(value) for value in (high - low)],
                "center_m": [float(value) for value in ((low + high) * 0.5)],
            }
        )
    return bodies


def body_tracks(header: list[str], table: np.ndarray, bodies: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    frames = table.shape[0]
    pos = np.zeros((frames, len(bodies), 3), dtype=np.float32)
    quat = np.zeros((frames, len(bodies), 4), dtype=np.float32)
    quat[..., 3] = 1.0
    for index, body in enumerate(bodies):
        start = header.index(f"{body['id']}_x")
        pos[:, index, :] = table[:, start : start + 3]
        quat[:, index, :] = table[:, start + 3 : start + 7]
    return pos, quat


def build_one(
    robot_csv: Path,
    object_xml: Path,
    object_csv: Path,
    urdf: Path,
    output: Path,
    style: str,
) -> dict:
    joints = actuated_joints(urdf)
    motion = read_robot_csv(robot_csv)
    header, objects = read_object_csv(object_csv)
    bodies = scene_bodies(object_xml)
    count = min(motion.shape[0], objects.shape[0])
    motion = motion[:count]
    objects = objects[:count]
    if motion.shape[1] < 7 + len(joints):
        raise ValueError(
            f"{robot_csv.name} 只有 {motion.shape[1] - 7} 个关节列，URDF 有 {len(joints)} 个"
        )
    joint_pos = motion[:, 7 : 7 + len(joints)]
    body_pos, body_quat = body_tracks(header, objects, bodies)
    meta = {
        "format": "hub-hoi",
        "format_version": 1,
        "fps": FPS,
        "frame_count": int(count),
        "duration_sec": float(count / FPS),
        "world": {"up": "z", "unit": "m", "quat": "xyzw", "origin": "capture"},
        "robot": {
            "track": style,
            "model_id": f"robot/{style}/{urdf.stem}",
            "urdf": f"urdf/{urdf.name}",
            "joint_names": joints,
        },
        "bodies": bodies,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": np.frombuffer(json.dumps(meta, ensure_ascii=False).encode("utf-8"), dtype=np.uint8),
        "robot_root_pos": np.ascontiguousarray(motion[:, 0:3], dtype=np.float32),
        "robot_root_quat": np.ascontiguousarray(motion[:, 3:7], dtype=np.float32),
        "robot_joint_pos": np.ascontiguousarray(joint_pos, dtype=np.float32),
    }
    if bodies:
        payload["body_pos"] = np.ascontiguousarray(body_pos, dtype=np.float32)
        payload["body_quat"] = np.ascontiguousarray(body_quat, dtype=np.float32)
    np.savez_compressed(output, **payload)
    return {
        "path": output.relative_to(HUB).as_posix(),
        "annotation": {
            "motion_kind": "merged",
            "robot_style": style,
            "robot_version": f"urdf/{urdf.name}",
            "robot_model_id": meta["robot"]["model_id"],
            "fps": 30,
            "world_frame": "capture_z_up",
            "note": "机器人合并数据。30Hz，Z-up，米，四元数 xyzw。网格在 3D 模型库，不写进本文件。",
        },
    }


def export_batch(batch: str) -> list[dict]:
    written: list[dict] = []
    for style in STYLES:
        urdf = style_urdf(style)
        csv_dir = HUB / "data" / "robot" / style / "motion" / "omniretarget" / "skeleton" / "csv" / batch
        if not csv_dir.is_dir():
            continue
        for robot_csv in sorted(csv_dir.glob("*.csv")):
            xml_path = (
                HUB
                / "data"
                / "robot"
                / style
                / "motion"
                / "omniretarget"
                / "object"
                / "xml"
                / batch
                / f"{robot_csv.stem}.xml"
            )
            csv_path = (
                HUB
                / "data"
                / "robot"
                / style
                / "motion"
                / "omniretarget"
                / "object"
                / "csv"
                / batch
                / f"{robot_csv.stem}.csv"
            )
            if not xml_path.is_file() or not csv_path.is_file():
                continue
            output = (
                HUB
                / "data"
                / "robot"
                / style
                / "motion"
                / "omniretarget"
                / "merged"
                / "npz"
                / batch
                / f"{robot_csv.stem}.npz"
            )
            written.append(build_one(robot_csv, xml_path, csv_path, urdf, output, style))
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description="Export robot HOI clips to npz.")
    parser.add_argument("--batch", default="260317_parkour")
    parser.add_argument("--manifest", type=Path, default=HUB / "index" / "_robot_hoi_npz_ann.json")
    args = parser.parse_args()
    written = export_batch(args.batch)
    args.manifest.write_text(json.dumps(written, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(written)} npz, manifest {args.manifest}")


if __name__ == "__main__":
    main()
