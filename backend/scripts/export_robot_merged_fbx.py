"""Write one robot merged FBX: robot skeleton motion plus rigid bodies and markers.

The numbers stay in the same frame as the robot skeleton CSV and the object
CSV: metres, Z-up, capture origin. The human merged FBX was turned into that
frame already; this file puts the retargeted robot in the human skeleton's
place and keeps the object trajectories.

Run with the Python 3.7 that can load the FBX SDK:

    PYTHONPATH=.../fbxpythonsdk_linux/lib/Python37_x64 \\
    python3.7 backend/scripts/export_robot_merged_fbx.py
"""

from __future__ import annotations

import math
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

import fbx

HUB = Path("/media/noetix/my_passport1/noetix_robot_data_hub/data/hub_repo")
URDF = HUB / "3d_model/robot/standard_description/noetix_e2/urdf/noetix_e2_23dof.urdf"
STEM = "中障碍物11_侧腿上箱_低速_宽_001"
BATCH = "260317_parkour"
STYLE = "noetix_e2"
FPS = 30.0
ROBOT_CSV = HUB / "data/robot" / STYLE / "motion/omniretarget/skeleton/csv" / BATCH / (STEM + ".csv")
OBJECT_XML = HUB / "data/robot" / STYLE / "motion/omniretarget/object/xml" / BATCH / (STEM + ".xml")
OBJECT_CSV = HUB / "data/robot" / STYLE / "motion/omniretarget/object/csv" / BATCH / (STEM + ".csv")
OUT = HUB / "data/robot" / STYLE / "motion/omniretarget/merged/fbx" / BATCH / (STEM + ".fbx")


def _vec3(text):
    parts = (text or "0 0 0").split()
    return tuple(float(parts[i]) if i < len(parts) else 0.0 for i in range(3))


def _read_stl(path):
    data = path.read_bytes()
    if data.lstrip()[:5].lower() == b"solid" and b"facet" in data[:4096].lower():
        return _read_ascii_stl(data.decode("utf-8", errors="ignore"))
    count = struct.unpack_from("<I", data, 80)[0]
    points = []
    faces = []
    lookup = {}
    offset = 84
    for _ in range(count):
        vals = struct.unpack_from("<12f", data, offset)
        offset += 50
        face = []
        for corner in range(3):
            point = vals[3 + corner * 3 : 6 + corner * 3]
            key = tuple(round(value, 6) for value in point)
            index = lookup.get(key)
            if index is None:
                index = len(points)
                lookup[key] = index
                points.append(point)
            face.append(index)
        faces.append(tuple(face))
    return points, faces


def _read_ascii_stl(text):
    points = []
    faces = []
    lookup = {}
    face = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0] == "vertex":
            point = (float(parts[1]), float(parts[2]), float(parts[3]))
            key = tuple(round(value, 6) for value in point)
            index = lookup.get(key)
            if index is None:
                index = len(points)
                lookup[key] = index
                points.append(point)
            face.append(index)
            if len(face) == 3:
                faces.append(tuple(face))
                face = []
    return points, faces


def _mesh_path(filename):
    raw = (filename or "").replace("\\", "/")
    name = Path(raw).name
    candidates = [
        URDF.parent / raw,
        URDF.parent.parent / "meshes" / name,
        URDF.parent.parent / "meshes_hires" / name,
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def _parse_urdf():
    root = ET.parse(str(URDF)).getroot()
    links = {}
    for link in root.findall("link"):
        visuals = []
        for visual in link.findall("visual"):
            mesh = visual.find("geometry/mesh")
            if mesh is None:
                continue
            origin = visual.find("origin")
            color = visual.find("material/color")
            rgba = _vec3(color.get("rgba") if color is not None else "") + (1.0,)
            if color is not None and color.get("rgba"):
                parts = color.get("rgba").split()
                rgba = tuple(float(parts[i]) for i in range(min(3, len(parts))))
            visuals.append(
                {
                    "file": mesh.get("filename") or "",
                    "xyz": _vec3(origin.get("xyz") if origin is not None else ""),
                    "rpy": _vec3(origin.get("rpy") if origin is not None else ""),
                    "color": rgba[:3],
                }
            )
        links[link.get("name")] = {"visuals": visuals}
    joints = []
    children = set()
    for joint in root.findall("joint"):
        origin = joint.find("origin")
        axis = joint.find("axis")
        parent = joint.find("parent").get("link")
        child = joint.find("child").get("link")
        joints.append(
            {
                "name": joint.get("name"),
                "type": (joint.get("type") or "").lower(),
                "parent": parent,
                "child": child,
                "xyz": _vec3(origin.get("xyz") if origin is not None else ""),
                "rpy": _vec3(origin.get("rpy") if origin is not None else ""),
                "axis": _vec3(axis.get("xyz") if axis is not None else "0 0 1"),
            }
        )
        children.add(child)
    roots = [name for name in links if name not in children]
    if "base_link" in links:
        roots = ["base_link"]
    return links, joints, roots


def _read_robot_csv(path):
    frames = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        values = [float(item) for item in line.split(",")]
        frames.append(
            {
                "xyz": tuple(values[0:3]),
                "quat": tuple(values[3:7]),
                "joints": values[7:],
            }
        )
    return frames


def _parse_object_xml(path):
    root = ET.parse(str(path)).getroot()
    bodies = []
    for body in root.findall("body"):
        points = [
            (float(node.get("x") or 0), float(node.get("y") or 0), float(node.get("z") or 0))
            for node in body.findall("vertices/v")
        ]
        faces = [
            (int(node.get("a")), int(node.get("b")), int(node.get("c")))
            for node in body.findall("faces/f")
        ]
        bodies.append(
            {
                "id": body.get("id") or body.get("name") or "object",
                "name": body.get("name") or body.get("id") or "object",
                "kind": body.get("kind") or "rigid",
                "points": points,
                "faces": faces,
            }
        )
    return bodies


def _read_object_csv(path, bodies):
    lines = [line for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    header = [item.strip() for item in lines[0].split(",")]
    columns = []
    for body in bodies:
        start = header.index(body["id"] + "_x")
        columns.append(start)
    poses = []
    for line in lines[1:]:
        cells = line.split(",")
        frame = []
        for start in columns:
            frame.append(tuple(float(cells[start + offset]) for offset in range(7)))
        poses.append(frame)
    return poses


def _sphere(radius, segments):
    points = []
    faces = []
    for row in range(segments + 1):
        v = row / float(segments)
        phi = v * math.pi
        for col in range(segments):
            u = col / float(segments)
            theta = u * 2.0 * math.pi
            points.append(
                (
                    radius * math.sin(phi) * math.cos(theta),
                    radius * math.sin(phi) * math.sin(theta),
                    radius * math.cos(phi),
                )
            )
    def index(row, col):
        return row * segments + (col % segments)
    for row in range(segments):
        for col in range(segments):
            a = index(row, col)
            b = index(row + 1, col)
            c = index(row + 1, col + 1)
            d = index(row, col + 1)
            faces.append((a, b, c))
            faces.append((a, c, d))
    return points, faces


def _euler(quat_xyzw=None, rpy=None, axis=None, angle=0.0):
    matrix = fbx.FbxAMatrix()
    if quat_xyzw is not None:
        qx, qy, qz, qw = quat_xyzw
        matrix.SetQ(fbx.FbxQuaternion(qx, qy, qz, qw))
        return matrix.GetR()
    origin = fbx.FbxAMatrix()
    roll, pitch, yaw = rpy or (0.0, 0.0, 0.0)
    origin.SetR(fbx.FbxVector4(math.degrees(roll), math.degrees(pitch), math.degrees(yaw)))
    joint = fbx.FbxAMatrix()
    half = angle * 0.5
    scale = math.sin(half)
    ax, ay, az = axis or (0.0, 0.0, 1.0)
    joint.SetQ(fbx.FbxQuaternion(ax * scale, ay * scale, az * scale, math.cos(half)))
    return (origin * joint).GetR()


def _fbx_mesh(scene, name, points, faces):
    mesh = fbx.FbxMesh.Create(scene, name)
    mesh.InitControlPoints(len(points))
    for index, (x, y, z) in enumerate(points):
        mesh.SetControlPointAt(fbx.FbxVector4(x, y, z, 0.0), index)
    for face in faces:
        mesh.BeginPolygon(-1)
        for index in face:
            mesh.AddPolygon(int(index))
        mesh.EndPolygon()
    return mesh


def _material(scene, name, color):
    material = fbx.FbxSurfacePhong.Create(scene, name)
    material.Diffuse.Set(fbx.FbxDouble3(color[0], color[1], color[2]))
    return material


def _node(scene, name, parent, mesh=None, material=None):
    node = fbx.FbxNode.Create(scene, name)
    if mesh is not None:
        node.SetNodeAttribute(mesh)
    if material is not None:
        node.AddMaterial(material)
    node.SetRotationOrder(fbx.FbxNode.eSourcePivot, fbx.eEulerXYZ)
    parent.AddChild(node)
    return node


def _curve(prop, layer, component, keys):
    curve = prop.GetCurve(layer, component, True)
    curve.KeyModifyBegin()
    for time, value in keys:
        index = curve.KeyAdd(time)[0]
        curve.KeySetValue(index, float(value))
        curve.KeySetInterpolation(index, fbx.FbxAnimCurveDef.eInterpolationLinear)
    curve.KeyModifyEnd()


def _write_trs(node, layer, times, translations, rotations):
    if translations:
        prop = node.LclTranslation
        _curve(prop, layer, "X", [(time, item[0]) for time, item in zip(times, translations)])
        _curve(prop, layer, "Y", [(time, item[1]) for time, item in zip(times, translations)])
        _curve(prop, layer, "Z", [(time, item[2]) for time, item in zip(times, translations)])
        node.LclTranslation.Set(fbx.FbxDouble3(*translations[0]))
    if rotations:
        prop = node.LclRotation
        _curve(prop, layer, "X", [(time, item[0]) for time, item in zip(times, rotations)])
        _curve(prop, layer, "Y", [(time, item[1]) for time, item in zip(times, rotations)])
        _curve(prop, layer, "Z", [(time, item[2]) for time, item in zip(times, rotations)])
        node.LclRotation.Set(fbx.FbxDouble3(rotations[0][0], rotations[0][1], rotations[0][2]))


def _prefix_name(prefix, name):
    return name if not prefix else prefix + name


def build(urdf, robot_csvs, object_xml, object_csv, out, fps=30.0):
    global URDF, FPS
    URDF = Path(urdf)
    FPS = float(fps)
    out = Path(out)
    if isinstance(robot_csvs, (str, Path)):
        robot_csvs = [robot_csvs]
    robot_csvs = [Path(path) for path in robot_csvs]
    links, joints, roots = _parse_urdf()
    robot_tracks = [_read_robot_csv(path) for path in robot_csvs]
    bodies = _parse_object_xml(Path(object_xml))
    object_frames = _read_object_csv(Path(object_csv), bodies)
    count = min([len(track) for track in robot_tracks] + [len(object_frames)])
    actuated = [joint for joint in joints if joint["type"] in ("revolute", "continuous", "prismatic")]
    for track in robot_tracks:
        if len(track[0]["joints"]) < len(actuated):
            raise RuntimeError("机器人 CSV 关节列少于 URDF 可动关节")

    manager = fbx.FbxManager.Create()
    ios = fbx.FbxIOSettings.Create(manager, fbx.IOSROOT)
    manager.SetIOSettings(ios)
    scene = fbx.FbxScene.Create(manager, out.stem)
    settings = scene.GetGlobalSettings()
    settings.SetSystemUnit(fbx.FbxSystemUnit.m)
    settings.SetAxisSystem(fbx.FbxAxisSystem.MayaZUp)
    settings.SetTimeMode(fbx.FbxTime.eFrames30)
    stack = fbx.FbxAnimStack.Create(scene, "Take 001")
    layer = fbx.FbxAnimLayer.Create(scene, "BaseLayer")
    stack.AddMember(layer)
    scene.SetCurrentAnimationStack(stack)
    times = []
    for index in range(count):
        time = fbx.FbxTime()
        time.SetSecondDouble(index / FPS)
        times.append(time)
    span = fbx.FbxTimeSpan(times[0], times[-1])
    stack.SetLocalTimeSpan(span)
    settings.SetTimelineDefaultTimeSpan(span)

    robot_grey = _material(scene, "RobotGrey", (0.72, 0.75, 0.78))
    wood = _material(scene, "ObstacleWood", (0.76, 0.60, 0.36))
    marker_mat = _material(scene, "MarkerYellow", (1.0, 0.82, 0.15))
    by_child = {joint["child"]: joint for joint in joints}

    def add_robot(robot_frames, prefix):
        def add_link(link_name, parent_node):
            joint = by_child.get(link_name)
            node = _node(scene, _prefix_name(prefix, link_name), parent_node)
            if joint is None:
                translations = [frame["xyz"] for frame in robot_frames[:count]]
                rotations = [_euler(quat_xyzw=frame["quat"]) for frame in robot_frames[:count]]
                _write_trs(node, layer, times, translations, rotations)
            else:
                node.LclTranslation.Set(fbx.FbxDouble3(*joint["xyz"]))
                angle_index = actuated.index(joint) if joint in actuated else None
                rotations = []
                for frame in robot_frames[:count]:
                    angle = frame["joints"][angle_index] if angle_index is not None else 0.0
                    rotations.append(_euler(rpy=joint["rpy"], axis=joint["axis"], angle=angle))
                _write_trs(node, layer, times, None, rotations)
            for visual_index, visual in enumerate(links.get(link_name, {}).get("visuals", [])):
                mesh_path = _mesh_path(visual["file"])
                if mesh_path is None:
                    continue
                points, faces = _read_stl(mesh_path)
                mesh_name = _prefix_name(prefix, link_name) + "_mesh_" + str(visual_index)
                mesh = _fbx_mesh(scene, mesh_name, points, faces)
                visual_node = _node(
                    scene,
                    _prefix_name(prefix, link_name) + "_visual_" + str(visual_index),
                    node,
                    mesh,
                    robot_grey,
                )
                if any(abs(value) > 1e-8 for value in visual["xyz"] + visual["rpy"]):
                    visual_node.LclTranslation.Set(fbx.FbxDouble3(*visual["xyz"]))
                    visual_node.LclRotation.Set(
                        fbx.FbxDouble3(
                            math.degrees(visual["rpy"][0]),
                            math.degrees(visual["rpy"][1]),
                            math.degrees(visual["rpy"][2]),
                        )
                    )
            for joint in joints:
                if joint["parent"] == link_name:
                    add_link(joint["child"], node)

        for root_name in roots:
            add_link(root_name, scene.GetRootNode())

    for index, track in enumerate(robot_tracks):
        add_robot(track, "" if index == 0 else "robot{}_".format(index + 1))

    for body_index, body in enumerate(bodies):
        has_mesh = body["kind"] != "marker" and len(body["points"]) >= 3 and body["faces"]
        label = body["name"]
        if has_mesh:
            mesh = _fbx_mesh(scene, body["id"] + "_mesh", body["points"], body["faces"])
            node = _node(scene, label, scene.GetRootNode(), mesh, wood)
        else:
            # Empty node. The viewer adds the same disc or dot used on the human FBX.
            node = _node(scene, label, scene.GetRootNode())
        translations = []
        rotations = []
        for frame in object_frames[:count]:
            pose = frame[body_index]
            translations.append(pose[0:3])
            rotations.append(_euler(quat_xyzw=pose[3:7]))
        _write_trs(node, layer, times, translations, rotations)

    out.parent.mkdir(parents=True, exist_ok=True)
    exporter = fbx.FbxExporter.Create(manager, "")
    fmt = manager.GetIOPluginRegistry().GetNativeWriterFormat()
    if not exporter.Initialize(str(out), fmt, ios):
        manager.Destroy()
        raise RuntimeError(exporter.GetStatus().GetErrorString())
    ok = exporter.Export(scene)
    exporter.Destroy()
    manager.Destroy()
    if not ok:
        raise RuntimeError("导出失败")
    print("wrote {} bytes {}".format(out, out.stat().st_size))


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Retarget a human merged scene into a robot merged FBX.")
    parser.add_argument("--urdf", default=str(URDF))
    parser.add_argument("--robot-csv", action="append", default=None)
    parser.add_argument("--object-xml", default=str(OBJECT_XML))
    parser.add_argument("--object-csv", default=str(OBJECT_CSV))
    parser.add_argument("--output", default=str(OUT))
    parser.add_argument("--fps", type=float, default=FPS)
    args = parser.parse_args()
    robot_csvs = args.robot_csv or [str(ROBOT_CSV)]
    build(args.urdf, robot_csvs, args.object_xml, args.object_csv, args.output, args.fps)


if __name__ == "__main__":
    main()
