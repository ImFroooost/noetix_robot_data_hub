"""Export rigid bodies and markers from a merged FBX into one XML and one CSV.

The world frame is the capture origin. The Y-up axes are rotated -90 deg about
X (right-hand rule). Point coordinates become metres and (x, -z, y). Hip
centering, heading alignment, the X mirror, the toe-floor shift and the
robot-height scale are not applied. The web Z-up view then matches the Y-up FBX.

CSV frame rate is 30 Hz, matching batch_retarget_to_csv. The first line is
the column names. Each body or marker has x, y, z and a quaternion xyzw.

Run with the holosoma interpreter:

    hsretargeting/bin/python backend/scripts/export_scene_objects.py \\
        --input clip_merged.fbx --xml scene.xml --csv scene.csv
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation, Slerp

PKG = Path(
    "/home/noetix/Desktop/new_home/learning_based/wbc/open_src/omni_retarget/"
    "holosoma/src/holosoma_retargeting"
)
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(PKG / "holosoma_retargeting" / "data_utils"))

from fbx_scene_points import (  # noqa: E402
    _apply_transform,
    _matrix_from_node,
    interaction_sources,
    load_rigid_meshes,
)
from prep_bvh_for_rt import CAPTURE_Z_UP_MATRIX  # noqa: E402
from prep_fbx_for_rt import (  # noqa: E402
    _append_rest_nodes,
    _parent_map,
    _require_pufbx,
    bake_fbx_local_channels,
    discover_skeleton_names,
)
from retarget_to_csv import TARGET_FPS, detect_input_fps  # noqa: E402

# Same Rx(+90) on points as prep_fbx capture_z_up: (x, y, z)_yup -> (x, -z, y)_zup.
_TO_Z_UP = CAPTURE_Z_UP_MATRIX
_TOKEN = re.compile(r"\s+")


def _column_token(name: str, used: set[str]) -> str:
    token = _TOKEN.sub("_", name.strip())
    token = re.sub(r"[^\w.\-]+", "_", token, flags=re.UNICODE).strip("._")
    token = token or "object"
    base = token
    index = 2
    while token in used:
        token = f"{base}_{index}"
        index += 1
    used.add(token)
    return token


def _rotation_of(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Split a 3x3 into rotation and per-axis scale. Scale may be negative."""
    raw = np.asarray(matrix, dtype=np.float64).reshape(3, 3)
    scale = np.linalg.norm(raw, axis=0)
    scale[scale < 1e-8] = 1.0
    rotation = raw / scale
    if float(np.linalg.det(rotation)) < 0.0:
        rotation[:, 0] *= -1.0
        scale[0] *= -1.0
    return rotation, scale


def _resample_poses(
    times: np.ndarray,
    positions: np.ndarray,
    quaternions: np.ndarray,
    fps: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Match convert_input_to_npz: exact integer stride, otherwise 30 Hz interp."""
    times = np.asarray(times, dtype=np.float64)
    positions = np.asarray(positions, dtype=np.float64)
    quaternions = np.asarray(quaternions, dtype=np.float64)
    if len(times) < 2:
        return times, positions, quaternions
    duration = float(times[-1] - times[0])
    step = float(np.median(np.diff(times)))
    native = 1.0 / step if step > 1e-9 else fps
    downsample = max(1, int(round(native / TARGET_FPS)))
    exact = abs(native / downsample - TARGET_FPS) < 0.5
    if exact and downsample > 1:
        sigma = 0.5 * downsample
        positions = gaussian_filter1d(positions, sigma=sigma, axis=0, mode="nearest")
        positions = positions[::downsample]
        quaternions = quaternions[::downsample]
        count = positions.shape[0]
        out_times = np.arange(count, dtype=np.float64) / TARGET_FPS
        return out_times, positions, _continuous_quat(quaternions)

    src = times - float(times[0])
    count = int(np.floor(duration * TARGET_FPS)) + 1
    out_times = np.arange(count, dtype=np.float64) / TARGET_FPS
    out_pos = np.empty((count, positions.shape[1], 3), dtype=np.float64)
    for body in range(positions.shape[1]):
        for axis in range(3):
            out_pos[:, body, axis] = np.interp(out_times, src, positions[:, body, axis])
    out_quat = np.empty((count, quaternions.shape[1], 4), dtype=np.float64)
    for body in range(quaternions.shape[1]):
        series = _continuous_quat(quaternions[:, body])
        if len(src) < 2:
            out_quat[:, body] = series[0]
            continue
        slerp = Slerp(src, Rotation.from_quat(series))
        out_quat[:, body] = slerp(np.clip(out_times, src[0], src[-1])).as_quat()
    return out_times, out_pos, out_quat


def _continuous_quat(quaternions: np.ndarray) -> np.ndarray:
    out = np.array(quaternions, dtype=np.float64, copy=True)
    if out.ndim == 2:
        for index in range(1, len(out)):
            if float(np.dot(out[index], out[index - 1])) < 0.0:
                out[index] *= -1.0
        return out
    for body in range(out.shape[1]):
        out[:, body] = _continuous_quat(out[:, body])
    return out


def _optical_marker(name: str, attrib: str) -> bool:
    """Motive optical points, including ones pufbx reports as UNKNOWN."""
    if not name or name in {"Root", "Marker Null Root"} or name.endswith("_Root"):
        return False
    if attrib.upper() in {"BONE", "MESH"}:
        return False
    low = name.lower()
    if low in {"optical"} or low.endswith(":optical") or low.endswith("_optical"):
        return False
    return low.startswith("c3d:") or "marker" in low or "unlabeled" in low


def _scene_nodes(fbx: Path, scene, skeletons: list[str]) -> list[tuple[str, str]]:
    """Rigid bodies plus every optical point, in a stable order.

    Skeleton markers stay in the list. The robot view draws the same points
    the human merged FBX draws; only the two performers become robots.
    """
    chosen: list[tuple[str, str]] = []
    seen: set[str] = set()
    for source in interaction_sources(fbx, scene, skeletons):
        if source.node_name in seen:
            continue
        seen.add(source.node_name)
        kind = "marker" if source.description == "marker" else "rigid"
        chosen.append((source.node_name, kind))
    for node in scene.nodes:
        name = node.name or ""
        if name in seen or not _optical_marker(name, str(node.attrib_type)):
            continue
        seen.add(name)
        chosen.append((name, "marker"))
    return chosen


def _local_vertices(fbx: Path, scene) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Node-local mesh vertices in centimetres, and triangle faces."""
    meshes = load_rigid_meshes(fbx)
    by_name = {node.name: node for node in scene.nodes if node.name}
    local: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for name, (vertices, faces) in meshes.items():
        node = by_name.get(name)
        if node is None:
            continue
        points = _apply_transform(_matrix_from_node(node), np.asarray(vertices, dtype=np.float64))
        local[name] = (points, np.asarray(faces, dtype=np.int32))
    return local


def export_scene(fbx: Path, xml_path: Path, csv_path: Path) -> bool:
    """Write the scene. Returns False when the FBX has no object nodes."""
    fbx = Path(fbx)
    pufbx = _require_pufbx()
    scene = pufbx.load_fbx(str(fbx))
    parents = _parent_map(scene)
    data, times, node_names = bake_fbx_local_channels(scene)
    node_names = list(node_names)
    skeletons = discover_skeleton_names(node_names)
    bodies = _scene_nodes(fbx, scene, skeletons)
    if not bodies:
        return False
    data, node_names = _append_rest_nodes(scene, data, node_names, parents, [name for name, _kind in bodies])
    names = [name for name, _kind in bodies]
    mats = world_mats_from_safe(data, times, node_names, parents, names)
    local_meshes = _local_vertices(fbx, scene)

    count = mats.shape[0]
    positions = np.zeros((count, len(bodies), 3), dtype=np.float64)
    quaternions = np.zeros((count, len(bodies), 4), dtype=np.float64)
    quaternions[..., 3] = 1.0
    baked_scale: list[np.ndarray] = []
    for index in range(len(bodies)):
        scales = []
        rotations = []
        for frame in range(count):
            rotation, scale = _rotation_of(mats[frame, index, :3, :3])
            scales.append(scale)
            rotations.append(rotation)
            positions[frame, index] = mats[frame, index, :3, 3] * 0.01
        scale_stack = np.stack(scales)
        scale0 = scale_stack[0]
        if float(np.max(np.abs(scale_stack - scale0))) > 1e-3:
            print(f"  {names[index]}: scale changes over time; baking the first frame")
        baked_scale.append(scale0)
        rot_z = np.einsum("ij,tjk->tik", _TO_Z_UP, np.stack(rotations))
        positions[:, index] = positions[:, index] @ _TO_Z_UP.T
        quaternions[:, index] = Rotation.from_matrix(rot_z).as_quat()

    native_fps = detect_input_fps(fbx)
    out_times, positions, quaternions = _resample_poses(times, positions, quaternions, native_fps)
    _write_xml(
        xml_path,
        fbx,
        bodies,
        local_meshes,
        baked_scale,
        len(out_times),
        positions,
        quaternions,
    )
    _write_csv(csv_path, bodies, out_times, positions, quaternions)
    print(
        f"Scene objects: {len(bodies)} nodes, {len(out_times)} frames @ {TARGET_FPS} Hz "
        f"-> {xml_path.name}, {csv_path.name}"
    )
    return True


def world_mats_from_safe(data, times, node_names, parents, names):
    from prep_fbx_for_rt import world_mats_from_local

    return world_mats_from_local(data, times, node_names, parents, names)


def _write_xml(
    path: Path,
    fbx: Path,
    bodies: list[tuple[str, str]],
    meshes: dict[str, tuple[np.ndarray, np.ndarray]],
    scales: list[np.ndarray],
    frames: int,
    positions: np.ndarray,
    quaternions: np.ndarray,
) -> None:
    root = ET.Element(
        "scene",
        {
            "version": "1",
            "units": "m",
            "up": "z",
            "fps": str(TARGET_FPS),
            "frames": str(frames),
            "origin": "capture",
            "source": fbx.name,
        },
    )
    note = ET.SubElement(root, "description")
    note.text = (
        "刚体和 marker 在动捕原点上。Y-up 坐标系绕 X 轴按右手定则转 -90 度得到 Z-up，"
        "点变成 (x, -z, y)，单位是米。"
        "没有镜像，没有把原点移到髋部，没有转朝向，没有按机器人身高缩放。"
        "位姿序列在同名 CSV，第一行是列名，四元数顺序为 xyzw。"
    )
    used: set[str] = set()
    for index, ((name, kind), scale) in enumerate(zip(bodies, scales)):
        token = _column_token(name, used)
        position = positions[0, index]
        quat = quaternions[0, index]
        body = ET.SubElement(
            root,
            "body",
            {
                "id": token,
                "name": name,
                "kind": kind,
                "x": f"{float(position[0]):.8f}",
                "y": f"{float(position[1]):.8f}",
                "z": f"{float(position[2]):.8f}",
                "qx": f"{float(quat[0]):.8f}",
                "qy": f"{float(quat[1]):.8f}",
                "qz": f"{float(quat[2]):.8f}",
                "qw": f"{float(quat[3]):.8f}",
            },
        )
        mesh = meshes.get(name)
        if mesh is None:
            continue
        vertices, faces = mesh
        baked = np.asarray(vertices, dtype=np.float64) * np.asarray(scale, dtype=np.float64) * 0.01
        vertex_node = ET.SubElement(body, "vertices", {"count": str(len(baked))})
        for point in baked:
            ET.SubElement(
                vertex_node,
                "v",
                {"x": f"{point[0]:.8f}", "y": f"{point[1]:.8f}", "z": f"{point[2]:.8f}"},
            )
        face_node = ET.SubElement(body, "faces", {"count": str(len(faces))})
        for face in faces:
            ET.SubElement(
                face_node,
                "f",
                {"a": str(int(face[0])), "b": str(int(face[1])), "c": str(int(face[2]))},
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    tree = ET.ElementTree(root)
    ET.indent(tree, space="  ")
    tree.write(path, encoding="utf-8", xml_declaration=True)


def _write_csv(
    path: Path,
    bodies: list[tuple[str, str]],
    times: np.ndarray,
    positions: np.ndarray,
    quaternions: np.ndarray,
) -> None:
    used: set[str] = set()
    tokens = [_column_token(name, used) for name, _kind in bodies]
    header = ["time_s"]
    for token in tokens:
        header.extend(
            [
                f"{token}_x",
                f"{token}_y",
                f"{token}_z",
                f"{token}_qx",
                f"{token}_qy",
                f"{token}_qz",
                f"{token}_qw",
            ]
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for frame, time in enumerate(times):
            row = [f"{float(time):.6f}"]
            for index in range(len(tokens)):
                position = positions[frame, index]
                quat = quaternions[frame, index]
                row.extend(f"{float(value):.8f}" for value in (*position, *quat))
            writer.writerow(row)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export FBX rigid bodies and markers to XML + CSV.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--xml", required=True, type=Path)
    parser.add_argument("--csv", required=True, type=Path)
    args = parser.parse_args()
    wrote = export_scene(args.input, args.xml, args.csv)
    if not wrote:
        print(f"No rigid bodies or markers in {args.input.name}")


if __name__ == "__main__":
    main()
