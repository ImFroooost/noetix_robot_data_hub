"""Add the parkour box into each obstacle FBX and write a merged copy.

The capture CSV is OptiTrack global, millimeters, Z-up. The human FBX is
centimeters and Y-up. The crossing moment lines up when the rigid body is:

    x_cm = -csv_x_mm / 10
    y_cm = csv_z_mm / 10
    z_cm = csv_y_mm / 10

The box stays axis-aligned. Its height is along Y, the 150 cm side along X,
and the narrow or wide side along Z. The rigid-body sample is the box center,
and it sits on the floor when that center is half the box height.
"""

from __future__ import annotations

import sys
from pathlib import Path

import fbx

HUB = Path(__file__).resolve().parents[2] / "data" / "hub_repo"
BATCH = "260317_parkour"
SIZES_CM = {
    ("低", "窄"): (150.0, 50.0, 50.0),
    ("低", "宽"): (150.0, 100.0, 50.0),
    ("中", "窄"): (150.0, 50.0, 80.0),
    ("中", "宽"): (150.0, 100.0, 80.0),
    ("高", "窄"): (150.0, 50.0, 140.0),
    ("高", "宽"): (150.0, 100.0, 140.0),
}


def obstacle_size(stem: str) -> tuple[float, float, float] | None:
    if stem.startswith("高"):
        height = "高"
    elif stem.startswith("中"):
        height = "中"
    elif stem.startswith("低"):
        height = "低"
    else:
        return None
    if "_宽_" in stem or stem.endswith("_宽"):
        width = "宽"
    elif "_窄_" in stem or stem.endswith("_窄"):
        width = "窄"
    else:
        return None
    return SIZES_CM[(height, width)]


def csv_track(path: Path) -> list[tuple[float, float, float, float]]:
    rows: list[tuple[float, float, float, float]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[8:]:
        parts = line.split(",")
        if len(parts) < 9 or not parts[6] or not parts[7] or not parts[8]:
            continue
        time_sec = float(parts[1])
        x_mm, y_mm, z_mm = float(parts[6]), float(parts[7]), float(parts[8])
        rows.append((time_sec, -x_mm / 10.0, z_mm / 10.0, y_mm / 10.0))
    if len(rows) < 2:
        raise ValueError(f"{path.name} 没有刚体轨迹")
    return rows


def _box_mesh(scene: fbx.FbxScene, length: float, width: float, height: float) -> fbx.FbxMesh:
    sx, sy, sz = length / 2.0, height / 2.0, width / 2.0
    corners = [
        (-sx, -sy, -sz),
        (sx, -sy, -sz),
        (sx, sy, -sz),
        (-sx, sy, -sz),
        (-sx, -sy, sz),
        (sx, -sy, sz),
        (sx, sy, sz),
        (-sx, sy, sz),
    ]
    # Outward faces, CCW when viewed from outside.
    faces = [
        (0, 1, 2, 3),
        (5, 4, 7, 6),
        (1, 5, 6, 2),
        (4, 0, 3, 7),
        (3, 2, 6, 7),
        (0, 4, 5, 1),
    ]
    mesh = fbx.FbxMesh.Create(scene, "ObstacleMesh")
    mesh.InitControlPoints(8)
    for index, (x, y, z) in enumerate(corners):
        mesh.SetControlPointAt(fbx.FbxVector4(x, y, z), index)
    for face in faces:
        mesh.BeginPolygon(-1)
        for index in face:
            mesh.AddPolygon(index)
        mesh.EndPolygon()
    return mesh


def _animation_layer(scene: fbx.FbxScene) -> fbx.FbxAnimLayer:
    stack = scene.GetCurrentAnimationStack()
    if stack is None:
        criteria = fbx.FbxCriteria.ObjectType(fbx.FbxAnimStack.ClassId)
        count = scene.GetSrcObjectCount(criteria)
        if count:
            stack = scene.GetSrcObject(criteria, 0)
            scene.SetCurrentAnimationStack(stack)
    if stack is None:
        raise ValueError("FBX 没有动画")
    layer_count = stack.GetMemberCount()
    for index in range(layer_count):
        member = stack.GetMember(index)
        if member and member.ClassId == fbx.FbxAnimLayer.ClassId:
            return member
    layer = fbx.FbxAnimLayer.Create(scene, "ObstacleLayer")
    stack.AddMember(layer)
    return layer


def _write_curve(prop, layer, component: str, keys: list[tuple[fbx.FbxTime, float]]) -> None:
    curve = prop.GetCurve(layer, component, True)
    curve.KeyModifyBegin()
    for time, value in keys:
        index = curve.KeyAdd(time)[0]
        curve.KeySetValue(index, float(value))
        curve.KeySetInterpolation(
            index, fbx.FbxAnimCurveDef.EInterpolationType.eInterpolationLinear
        )
    curve.KeyModifyEnd()


def add_obstacle(
    scene: fbx.FbxScene,
    length: float,
    width: float,
    height: float,
    track: list[tuple[float, float, float, float]],
) -> None:
    mesh = _box_mesh(scene, length, width, height)
    node = fbx.FbxNode.Create(scene, "Obstacle")
    node.SetNodeAttribute(mesh)
    material = fbx.FbxSurfacePhong.Create(scene, "ObstacleWood")
    material.Diffuse.Set(fbx.FbxDouble3(0.76, 0.58, 0.34))
    node.AddMaterial(material)
    scene.GetRootNode().AddChild(node)

    layer = _animation_layer(scene)
    keys_x: list[tuple[fbx.FbxTime, float]] = []
    keys_y: list[tuple[fbx.FbxTime, float]] = []
    keys_z: list[tuple[fbx.FbxTime, float]] = []
    for time_sec, x, y, z in track:
        time = fbx.FbxTime()
        time.SetSecondDouble(time_sec)
        keys_x.append((time, x))
        keys_y.append((time, y))
        keys_z.append((time, z))
    prop = node.LclTranslation
    _write_curve(prop, layer, "X", keys_x)
    _write_curve(prop, layer, "Y", keys_y)
    _write_curve(prop, layer, "Z", keys_z)


def convert_file(src: Path, dst: Path, size: tuple[float, float, float], track) -> None:
    manager = fbx.FbxManager.Create()
    ios = fbx.FbxIOSettings.Create(manager, fbx.IOSROOT)
    manager.SetIOSettings(ios)
    importer = fbx.FbxImporter.Create(manager, "")
    if not importer.Initialize(str(src), -1, ios):
        manager.Destroy()
        raise RuntimeError(importer.GetStatus().GetErrorString())
    scene = fbx.FbxScene.Create(manager, "scene")
    importer.Import(scene)
    importer.Destroy()
    add_obstacle(scene, size[0], size[1], size[2], track)
    exporter = fbx.FbxExporter.Create(manager, "")
    fmt = manager.GetIOPluginRegistry().GetNativeWriterFormat()
    if not exporter.Initialize(str(dst), fmt, ios):
        manager.Destroy()
        raise RuntimeError(exporter.GetStatus().GetErrorString())
    ok = exporter.Export(scene)
    exporter.Destroy()
    manager.Destroy()
    if not ok:
        raise RuntimeError(f"导出失败 {dst.name}")


def main() -> None:
    fbx_dir = HUB / "data" / "human" / "motion" / "skeleton" / "fbx" / BATCH
    csv_dir = HUB / "data" / "human" / "motion" / "skeleton" / "csv" / BATCH
    out_dir = HUB / "data" / "human" / "motion" / "merged" / "fbx" / BATCH
    out_dir.mkdir(parents=True, exist_ok=True)
    stems = []
    for path in sorted(fbx_dir.glob("*.fbx")):
        if path.stem.endswith("_merged"):
            continue
        if obstacle_size(path.stem) is None:
            continue
        stems.append(path.stem)
    only = sys.argv[1:] 
    if only:
        stems = [stem for stem in stems if stem in only]
    print(f"待处理 {len(stems)} 条", flush=True)
    for index, stem in enumerate(stems, start=1):
        size = obstacle_size(stem)
        assert size is not None
        src = fbx_dir / f"{stem}.fbx"
        csv_path = csv_dir / f"{stem}.csv"
        dst = out_dir / f"{stem}.fbx"
        if not csv_path.is_file():
            print(f"缺少 csv {stem}", flush=True)
            continue
        track = csv_track(csv_path)
        convert_file(src, dst, size, track)
        print(f"{index}/{len(stems)} {dst.name} {size[0]:.0f}x{size[1]:.0f}x{size[2]:.0f}", flush=True)


if __name__ == "__main__":
    main()
