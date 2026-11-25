"""Build a human merged FBX: skeleton motion plus every captured point.

The skeleton FBX already has the body and the rigid-body pivots. The C3D
file has the marker trajectories in the camera frame. This writes one FBX
per take under ``merged/fbx/<batch>/``, in the same centimetre Y-up frame as
the skeleton. Marker names follow the Motive export used by 260909_pingpong,
so the viewer can draw rigid-body links and a convex hull.

Run with the FBX SDK interpreter::

    /home/noetix/miniforge3/envs/fbx_sdk/bin/python \\
        backend/scripts/export_human_merged_fbx.py
"""

from __future__ import annotations

import argparse
import re
import struct
import sys
import time
from pathlib import Path

import fbx
import numpy as np

HUB = Path(__file__).resolve().parents[2] / "data" / "hub_repo"
DEFAULT_BATCHES = (
    "261113_PP",
    "261104_pingpong_pm",
    "261104_pingpong",
    "261103_pingpong",
)
BONE_PARTS = ("Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot")


def _find_param(data: bytes, name: str) -> int | None:
    token = name.encode("ascii")
    start = 0
    while True:
        index = data.find(token, start)
        if index < 0:
            return None
        # This exporter writes the parameter id between the length byte and the name.
        if index >= 2 and data[index - 2] == len(token):
            return index + len(token)
        start = index + 1


def _param_payload(data: bytes, name: str) -> tuple[int, int, list[int], int]:
    cursor = _find_param(data, name)
    if cursor is None:
        raise ValueError(f"C3D 缺少参数 {name}")
    # int16 byte-offset, int8 type, uint8 dimensions, then each dimension.
    cursor += 2
    kind = struct.unpack_from("<b", data, cursor)[0]
    dims_n = data[cursor + 1]
    dims = list(data[cursor + 2 : cursor + 2 + dims_n])
    return kind, dims_n, dims, cursor + 2 + dims_n


def _decode_float(chunk: bytes, swap_words: bool) -> float:
    if swap_words:
        chunk = chunk[2:4] + chunk[0:2]
    return struct.unpack("<f", chunk)[0]


def read_c3d(path: Path, swap_words: bool) -> tuple[list[str], np.ndarray, np.ndarray]:
    data = path.read_bytes()
    point_count = struct.unpack_from("<H", data, 2)[0]
    _, _, _, frames_at = _param_payload(data, "FRAMES")
    frames = struct.unpack_from("<H", data, frames_at)[0]
    _, _, _, start_at = _param_payload(data, "DATA_START")
    data_block = struct.unpack_from("<H", data, start_at)[0]
    _, _, dims, labels_at = _param_payload(data, "LABELS")
    width, count = (dims + [point_count, point_count])[:2]
    labels = []
    for index in range(count):
        raw = data[labels_at + index * width : labels_at + (index + 1) * width]
        labels.append(raw.split(b"\x00", 1)[0].decode("latin1").strip())
    if len(labels) < point_count:
        labels.extend(f"point_{index}" for index in range(len(labels), point_count))
    base = (data_block - 1) * 512
    stored = (len(data) - base) // (point_count * 16)
    frames = min(frames, stored) if frames else stored
    points = np.zeros((frames, point_count, 3), dtype=np.float64)
    valid = np.zeros((frames, point_count), dtype=bool)
    for frame in range(frames):
        offset = base + frame * point_count * 16
        for index in range(point_count):
            chunk = data[offset + index * 16 : offset + index * 16 + 16]
            points[frame, index] = [
                _decode_float(chunk[0:4], swap_words),
                _decode_float(chunk[4:8], swap_words),
                _decode_float(chunk[8:12], swap_words),
            ]
            residual = _decode_float(chunk[12:16], swap_words)
            valid[frame, index] = residual >= 0.0
    return labels[:point_count], points, valid


def marker_name(label: str) -> str:
    rigid = re.fullmatch(r"b_(.+)_(\d+)", label)
    if rigid:
        body = rigid.group(1)
        # The viewer treats a body named exactly "table" as a 4-point surface
        # and skips the links and hull. Keep every marker in one rigid body.
        if body.lower() == "table":
            body = "TableTop"
        number = int(rigid.group(2)) + 1
        return f"C3D:{body}_Marker_{number:03d}"
    unlabeled = re.fullmatch(r"unlabel_(\d+)", label, flags=re.IGNORECASE)
    if unlabeled:
        return f"C3D:Unlabeled_{unlabeled.group(1)}"
    skeleton = re.search(r"[Ss]keleton_(\d+)_(.+)", label)
    if skeleton:
        rest = skeleton.group(2).replace("-", "_")
        return f"C3D:Skeleton_{skeleton.group(1)}_{rest}"
    cleaned = re.sub(r"[^0-9A-Za-z_]+", "_", label).strip("_") or "point"
    return f"C3D:{cleaned}"


def _fill_gaps(track: np.ndarray, valid: np.ndarray) -> np.ndarray:
    filled = track.copy()
    last = None
    for index in range(len(filled)):
        if valid[index]:
            last = filled[index].copy()
        elif last is not None:
            filled[index] = last
    last = None
    for index in range(len(filled) - 1, -1, -1):
        if valid[index]:
            last = filled[index].copy()
        elif last is not None:
            filled[index] = last
    return filled


def load_scene(path: Path):
    manager = fbx.FbxManager.Create()
    ios = fbx.FbxIOSettings.Create(manager, fbx.IOSROOT)
    manager.SetIOSettings(ios)
    importer = fbx.FbxImporter.Create(manager, "")
    if not importer.Initialize(str(path), -1, ios):
        manager.Destroy()
        raise RuntimeError(importer.GetStatus().GetErrorString())
    scene = fbx.FbxScene.Create(manager, path.stem)
    importer.Import(scene)
    importer.Destroy()
    stack = scene.GetCurrentAnimationStack()
    if stack is None:
        manager.Destroy()
        raise RuntimeError(f"{path.name} 没有动画")
    scene.SetCurrentAnimationStack(stack)
    layer = stack.GetMember(fbx.FbxAnimLayer.ClassId, 0)
    return manager, scene, stack, layer, ios


def _find(node, name: str):
    if node.GetName() == name:
        return node
    for index in range(node.GetChildCount()):
        found = _find(node.GetChild(index), name)
        if found is not None:
            return found
    return None


def _skeleton_id(name: str) -> str | None:
    match = re.search(r"[Ss]keleton_(\d+)", name)
    return match.group(1) if match else None


def _body_part(label: str) -> str | None:
    upper = label.upper()
    if "HIP" in upper:
        return "Hips"
    if "HEAD" in upper:
        return "Head"
    if "FOOT" in upper and "L-" in upper:
        return "LeftFoot"
    if "FOOT" in upper and "R-" in upper:
        return "RightFoot"
    if ("HAND" in upper or "WIST" in upper) and "L-" in upper:
        return "LeftHand"
    if ("HAND" in upper or "WIST" in upper) and "R-" in upper:
        return "RightHand"
    return None


def _bones(root) -> dict[str, dict[str, object]]:
    """Skeleton id → body part → node. Each person is fitted on their own markers."""
    found: dict[str, dict[str, object]] = {}

    def walk(node) -> None:
        name = node.GetName()
        skeleton = _skeleton_id(name)
        for part in BONE_PARTS:
            if name.endswith(part) and not name.endswith(part + "End") and skeleton:
                found.setdefault(skeleton, {}).setdefault(part, node)
        for index in range(node.GetChildCount()):
            walk(node.GetChild(index))

    walk(root)
    return found


def _key_times(node, layer) -> list[float]:
    curve = node.LclTranslation.GetCurve(layer, "X", False)
    if curve is None or curve.KeyGetCount() < 2:
        return []
    return [curve.KeyGetTime(index).GetSecondDouble() for index in range(curve.KeyGetCount())]


def _positions(node, times: list[float]) -> np.ndarray:
    clock = fbx.FbxTime()
    values = np.zeros((len(times), 3), dtype=np.float64)
    for index, second in enumerate(times):
        clock.SetSecondDouble(second)
        translation = node.EvaluateGlobalTransform(clock).GetT()
        values[index] = (translation[0], translation[1], translation[2])
    return values


def _speed(values: np.ndarray) -> np.ndarray:
    if len(values) < 2:
        return np.zeros(0)
    return np.linalg.norm(np.diff(values, axis=0), axis=1)


def _best_lag(reference: np.ndarray, candidate: np.ndarray) -> tuple[int, float]:
    """How many FBX keys sit before the first C3D frame."""
    best_lag, best_score = 1, -1.0
    reference = reference[15:]
    for lag in range(0, 6):
        left = candidate[15 + lag :]
        count = min(len(reference), len(left))
        if count < 40:
            continue
        score = float(np.corrcoef(reference[:count], left[:count])[0, 1])
        if np.isnan(score):
            continue
        if score > best_score:
            best_lag, best_score = lag, score
    return best_lag, best_score


def _umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray, float]:
    count = len(src)
    src_mean = src.mean(axis=0)
    dst_mean = dst.mean(axis=0)
    src_delta = src - src_mean
    dst_delta = dst - dst_mean
    covariance = dst_delta.T @ src_delta / count
    left, singular, right = np.linalg.svd(covariance)
    rotation = left @ right
    if np.linalg.det(rotation) < 0:
        left[:, -1] *= -1
        rotation = left @ right
    variance = float(np.mean(np.sum(src_delta**2, axis=1)))
    scale = float(np.sum(singular) / variance) if variance else 1.0
    translation = dst_mean - scale * rotation @ src_mean
    predicted = scale * (rotation @ src.T).T + translation
    error = float(np.mean(np.linalg.norm(predicted - dst, axis=1)))
    return scale, rotation, translation, error


def _marker_groups(labels: list[str]) -> dict[str, dict[str, list[int]]]:
    groups: dict[str, dict[str, list[int]]] = {}
    for index, label in enumerate(labels):
        skeleton = _skeleton_id(label)
        part = _body_part(label)
        if not skeleton or not part:
            continue
        groups.setdefault(skeleton, {}).setdefault(part, []).append(index)
    return groups


def _mean_valid(points: np.ndarray, valid: np.ndarray, indexes: list[int], frame: int):
    chosen = [points[frame, index] for index in indexes if valid[frame, index]]
    if not chosen:
        return None
    return np.mean(chosen, axis=0)


def fit_transform(labels, points, valid, bones, times, lag: int):
    groups = _marker_groups(labels)
    src = []
    dst = []
    step = max(1, (len(times) - lag) // 40)
    for key in range(lag, len(times), step):
        frame = key - lag
        if frame >= len(points):
            break
        for skeleton, parts in groups.items():
            skeleton_bones = bones.get(skeleton) or {}
            for part, indexes in parts.items():
                node = skeleton_bones.get(part)
                if node is None:
                    continue
                center = _mean_valid(points, valid, indexes, frame)
                if center is None:
                    continue
                clock = fbx.FbxTime()
                clock.SetSecondDouble(times[key])
                translation = node.EvaluateGlobalTransform(clock).GetT()
                src.append(center)
                dst.append((translation[0], translation[1], translation[2]))
    if len(src) < 12:
        raise RuntimeError("能对上的骨架点太少，无法把 C3D 对齐到 FBX")
    return _umeyama(np.asarray(src), np.asarray(dst, dtype=np.float64))


def _rigid_indexes(labels: list[str]) -> dict[str, list[int]]:
    groups: dict[str, list[int]] = {}
    for index, label in enumerate(labels):
        match = re.fullmatch(r"b_(.+)_(\d+)", label)
        if not match:
            continue
        groups.setdefault(match.group(1), []).append(index)
    return groups


def choose_lag(labels, points, valid, scene, layer, times) -> tuple[int, float, str]:
    root = scene.GetRootNode()
    candidates = []
    for body, indexes in _rigid_indexes(labels).items():
        node = _find(root, body)
        if node is None:
            continue
        track = []
        for frame in range(len(points)):
            center = _mean_valid(points, valid, indexes, frame)
            track.append(center if center is not None else np.zeros(3))
        candidates.append((body, node, np.asarray(track)))
    if not candidates:
        hips = next((parts.get("Hips") for parts in _bones(root).values() if parts.get("Hips")), None)
        indexes = next((parts.get("Hips", []) for parts in _marker_groups(labels).values() if parts.get("Hips")), [])
        if hips is not None and indexes:
            track = []
            for frame in range(len(points)):
                center = _mean_valid(points, valid, indexes, frame)
                track.append(center if center is not None else np.zeros(3))
            candidates.append(("Hips", hips, np.asarray(track)))
    best = (1, -1.0, "")
    for name, node, track in candidates:
        node_speed = _speed(_positions(node, times))
        if len(node_speed) == 0 or float(np.percentile(node_speed, 95)) < 0.15:
            continue
        marker_speed = _speed(track)
        lag, score = _best_lag(marker_speed, node_speed)
        if score > best[1]:
            best = (lag, score, name)
    return best


def _add_curve(node, layer, times: list[fbx.FbxTime], values: np.ndarray) -> None:
    prop = node.LclTranslation
    node.LclTranslation.Set(fbx.FbxDouble3(float(values[0, 0]), float(values[0, 1]), float(values[0, 2])))
    for axis, component in enumerate("XYZ"):
        curve = prop.GetCurve(layer, component, True)
        curve.KeyModifyBegin()
        for index, moment in enumerate(times):
            key = curve.KeyAdd(moment)[0]
            curve.KeySetValue(key, float(values[index, axis]))
            curve.KeySetInterpolation(key, fbx.FbxAnimCurveDef.EInterpolationType.eInterpolationLinear)
        curve.KeyModifyEnd()


def write_markers(scene, layer, labels, world: np.ndarray, valid: np.ndarray, times: list[float], lag: int) -> int:
    root = scene.GetRootNode()
    optical = fbx.FbxNode.Create(scene, "C3D:optical")
    optical.SetNodeAttribute(fbx.FbxNull.Create(scene, "C3D:optical"))
    root.AddChild(optical)
    clocks = []
    for second in times:
        moment = fbx.FbxTime()
        moment.SetSecondDouble(second)
        clocks.append(moment)
    written = 0
    used_names: set[str] = set()
    for index, label in enumerate(labels):
        if not np.any(valid[:, index]):
            continue
        name = marker_name(label)
        while name in used_names:
            name += "_"
        used_names.add(name)
        track = _fill_gaps(world[:, index], valid[:, index])
        sampled = np.zeros((len(times), 3), dtype=np.float64)
        last = track[0]
        for key in range(len(times)):
            frame = key - lag
            if 0 <= frame < len(track):
                last = track[frame]
            sampled[key] = last
        node = fbx.FbxNode.Create(scene, name)
        marker = fbx.FbxMarker.Create(scene, name)
        node.SetNodeAttribute(marker)
        optical.AddChild(node)
        _add_curve(node, layer, clocks, sampled)
        written += 1
    return written


def export_scene(manager, scene, ios, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    exporter = fbx.FbxExporter.Create(manager, "")
    fmt = manager.GetIOPluginRegistry().GetNativeWriterFormat()
    if not exporter.Initialize(str(out), fmt, ios):
        raise RuntimeError(exporter.GetStatus().GetErrorString())
    ok = exporter.Export(scene)
    exporter.Destroy()
    if not ok:
        raise RuntimeError("导出失败")


def convert_file(fbx_path: Path, c3d_path: Path, out: Path) -> str:
    labels, points, valid = read_c3d(c3d_path, swap_words=True)
    manager, scene, _stack, layer, ios = load_scene(fbx_path)
    try:
        bones = _bones(scene.GetRootNode())
        hips = next((parts["Hips"] for parts in bones.values() if "Hips" in parts), None)
        times = _key_times(hips or next(iter(next(iter(bones.values())).values())), layer)
        if len(times) < 2:
            raise RuntimeError("骨架没有位移曲线")
        lag, score, driver = choose_lag(labels, points, valid, scene, layer, times)
        trials = [lag] if score >= 0.8 else [1, 0, 2, 3, lag]
        best = None
        for trial in dict.fromkeys(trials):
            try:
                trial_scale, trial_rotation, trial_translation, trial_error = fit_transform(
                    labels, points, valid, bones, times, trial
                )
            except RuntimeError:
                continue
            if best is None or trial_error < best[0]:
                best = (trial_error, trial, trial_scale, trial_rotation, trial_translation)
        if best is None or best[0] > 15.0:
            detail = "没有可用对齐" if best is None else f"对齐误差 {best[0]:.1f} cm，超过 15 cm"
            raise RuntimeError(detail)
        error, lag, scale, rotation, translation = best
        world = scale * np.einsum("ij,fnj->fni", rotation, points) + translation
        count = write_markers(scene, layer, labels, world, valid, times, lag)
        export_scene(manager, scene, ios, out)
    finally:
        manager.Destroy()
    return (
        f"lag {lag} via {driver} corr {score:.3f} "
        f"fit {error:.2f} cm scale {scale:.5f} markers {count}"
    )


def pairs_for(batch: str) -> list[tuple[Path, Path, Path]]:
    root = HUB / "data/human/motion"
    fbx_dir = root / "skeleton/fbx" / batch
    c3d_dir = root / "skeleton/c3d" / batch
    out_dir = root / "merged/fbx" / batch
    found = []
    if not fbx_dir.is_dir() or not c3d_dir.is_dir():
        return found
    for c3d_path in sorted(c3d_dir.glob("*.c3d")):
        fbx_path = fbx_dir / (c3d_path.stem + ".fbx")
        if fbx_path.is_file():
            found.append((fbx_path, c3d_path, out_dir / (c3d_path.stem + ".fbx")))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="把人体骨架 FBX 和 C3D 点合成合并 FBX")
    parser.add_argument("--batch", action="append", dest="batches")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    batches = args.batches or list(DEFAULT_BATCHES)
    jobs = []
    for batch in batches:
        jobs.extend(pairs_for(batch))
    if args.limit:
        jobs = jobs[: args.limit]
    print(f"jobs {len(jobs)}", flush=True)
    failed = 0
    started = time.time()
    for index, (fbx_path, c3d_path, out) in enumerate(jobs, start=1):
        if out.is_file() and out.stat().st_size > 0 and not args.force:
            print(f"[{index}/{len(jobs)}] skip {out.name}", flush=True)
            continue
        try:
            detail = convert_file(fbx_path, c3d_path, out)
            print(
                f"[{index}/{len(jobs)}] {fbx_path.parent.name}/{out.name} {detail} "
                f"{out.stat().st_size} bytes",
                flush=True,
            )
        except Exception as exc:
            failed += 1
            print(f"[{index}/{len(jobs)}] FAIL {fbx_path.name}: {exc}", flush=True)
    print(f"done failed {failed} elapsed {time.time() - started:.1f}s", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
