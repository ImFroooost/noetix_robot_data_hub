"""Build a holosoma retarget profile from an uploaded URDF.

The profile is enough for the retargeter to load the robot: degree of freedom,
scaling height, contact links and a human-joint map inferred from link names.
MuJoCo compiles the URDF into MJCF the first time a retarget job runs.
"""

from __future__ import annotations

import json
import os
import re
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

PROFILE_DIR_NAME = "retarget_robots"
_ACTUATED = frozenset({"revolute", "continuous", "prismatic"})


def profile_dir(hub: Path) -> Path:
    path = Path(hub) / "index" / PROFILE_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def choose_urdf(instance_dir: Path, default_rel: str = "") -> Path | None:
    """Prefer the user-selected URDF, otherwise the only URDF in the package."""
    rel = str(default_rel or "").replace("\\", "/").strip().lstrip("/")
    if rel.lower().endswith((".urdf", ".xacro")):
        chosen = instance_dir / rel
        if chosen.is_file():
            return chosen
    folder = instance_dir / "urdf"
    if not folder.is_dir():
        return None
    found = sorted(path for path in folder.rglob("*") if path.suffix.lower() in {".urdf", ".xacro"} and path.is_file())
    if len(found) == 1:
        return found[0]
    return None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_urdf(path: Path) -> tuple[list[str], list[str], list[tuple[str, str, tuple[float, float, float]]]]:
    tree = ET.parse(path)
    root = tree.getroot()
    links = [str(node.get("name") or "") for node in root.iter() if _local(node.tag) == "link" and node.get("name")]
    joints: list[str] = []
    edges: list[tuple[str, str, tuple[float, float, float]]] = []
    for node in root.iter():
        if _local(node.tag) != "joint":
            continue
        name = str(node.get("name") or "")
        kind = str(node.get("type") or "")
        if kind in _ACTUATED and name:
            joints.append(name)
        parent = child = ""
        xyz = (0.0, 0.0, 0.0)
        for child_node in list(node):
            tag = _local(child_node.tag)
            if tag == "parent":
                parent = str(child_node.get("link") or "")
            elif tag == "child":
                child = str(child_node.get("link") or "")
            elif tag == "origin" and child_node.get("xyz"):
                parts = child_node.get("xyz", "").split()
                if len(parts) == 3:
                    xyz = (float(parts[0]), float(parts[1]), float(parts[2]))
        if parent and child:
            edges.append((parent, child, xyz))
    return joints, links, edges


def _world_z(edges: list[tuple[str, str, tuple[float, float, float]]]) -> dict[str, float]:
    children = {child for _parent, child, _xyz in edges}
    parents = {parent for parent, _child, _xyz in edges}
    roots = [name for name in parents if name not in children]
    origin = {roots[0]: 0.0} if roots else {}
    pending = list(edges)
    changed = True
    while changed:
        changed = False
        rest: list[tuple[str, str, tuple[float, float, float]]] = []
        for parent, child, xyz in pending:
            if parent in origin:
                origin[child] = origin[parent] + xyz[2]
                changed = True
            else:
                rest.append((parent, child, xyz))
        pending = rest
    return origin


def _estimate_height(
    links: list[str],
    edges: list[tuple[str, str, tuple[float, float, float]]],
    urdf_path: Path | None = None,
    foot_links: list[str] | None = None,
) -> float:
    heights = _world_z(edges)
    if not heights:
        return 1.5
    base_names = [name for name in heights if _role(name) == "base"]
    foot_names = [name for name in (foot_links or []) if name in heights]
    if not foot_names:
        foot_names = [name for name in heights if _role(name) in {"foot", "toe"}]
    base_z = heights[base_names[0]] if base_names else max(heights.values())
    foot_z = min(heights[name] for name in foot_names) if foot_names else min(heights.values())
    if urdf_path is not None and foot_names:
        drop = _sole_drop(urdf_path, foot_names)
        if drop is not None:
            foot_z += drop
    pelvis = abs(base_z - foot_z)
    if pelvis < 0.2:
        return 1.5
    return max(0.9, min(2.4, pelvis / 0.64))


def _role(name: str) -> str:
    low = name.lower()
    if any(token in low for token in ("base_link", "pelvis", "torso")) and "hip" not in low:
        return "base"
    if "knee" in low:
        return "knee"
    if "ankle" in low or "foot" in low:
        return "foot"
    if "toe" in low:
        return "toe"
    if "shoulder" in low:
        return "shoulder"
    if "elbow" in low or "forearm" in low:
        return "elbow"
    if "wrist" in low or "hand" in low:
        return "hand"
    if "hip" in low:
        return "hip"
    if "waist" in low or "chest" in low:
        return "chest"
    return ""


def _side(name: str) -> str:
    low = name.lower()
    if low.startswith("l_") or low.startswith("left") or "_l_" in low or low.endswith("_l"):
        return "l"
    if low.startswith("r_") or low.startswith("right") or "_r_" in low or low.endswith("_r"):
        return "r"
    return ""


def _pick(links: list[str], side: str, role: str, prefer: tuple[str, ...] = ()) -> str:
    found = [name for name in links if _side(name) == side and _role(name) == role]
    for token in prefer:
        hit = [name for name in found if token in name.lower()]
        if hit:
            return sorted(hit, key=len)[0]
    return sorted(found, key=len)[0] if found else ""


def _pick_base(links: list[str]) -> str:
    for preferred in ("base_link", "pelvis", "torso_link", "torso"):
        for name in links:
            if name.lower() == preferred:
                return name
    for name in links:
        if _role(name) == "base":
            return name
    return links[0] if links else "base_link"


def _mapping(links: list[str], toe_left: str, toe_right: str, hand_left: str, hand_right: str) -> dict[str, dict[str, str]]:
    base = _pick_base(links)
    waists = [name for name in links if _role(name) == "chest"]
    chest = base
    for token in ("yaw", "pitch"):
        hit = [name for name in waists if token in name.lower()]
        if hit:
            chest = sorted(hit, key=len)[0]
            break
    else:
        if waists:
            chest = waists[0]

    def pair(role: str, prefer: tuple[str, ...] = ()) -> tuple[str, str]:
        return _pick(links, "l", role, prefer) or base, _pick(links, "r", role, prefer) or base

    hip_l, hip_r = pair("hip", ("hip_yaw", "hip_pitch"))
    knee_l, knee_r = pair("knee")
    foot_l, foot_r = pair("foot", ("ankle_pitch", "ankle_roll", "foot"))
    shoulder_l, shoulder_r = pair("shoulder", ("shoulder_roll", "shoulder_pitch"))
    elbow_l, elbow_r = pair("elbow", ("elbow_link", "elbow_pitch", "forearm"))
    bvh = {
        "Hips": base,
        "LeftUpLeg": hip_l,
        "RightUpLeg": hip_r,
        "LeftLeg": knee_l,
        "RightLeg": knee_r,
        "LeftFoot": foot_l,
        "RightFoot": foot_r,
        "LeftToeBase": toe_left,
        "RightToeBase": toe_right,
        "LeftArm": shoulder_l,
        "RightArm": shoulder_r,
        "LeftForeArm": elbow_l,
        "RightForeArm": elbow_r,
        "LeftHand": hand_left,
        "RightHand": hand_right,
    }
    optitrack = {
        "Hips": base,
        "LeftUpLeg": hip_l,
        "RightUpLeg": hip_r,
        "LeftLeg": knee_l,
        "RightLeg": knee_r,
        "LeftFoot": foot_l,
        "RightFoot": foot_r,
        "LeftToe": toe_left,
        "RightToe": toe_right,
        "LeftArm": shoulder_l,
        "RightArm": shoulder_r,
        "LeftForeArm": elbow_l,
        "RightForeArm": elbow_r,
        "LeftHand": hand_left,
        "RightHand": hand_right,
    }
    smpl = {
        "Pelvis": base,
        "Spine3": chest,
        "L_Hip": hip_l,
        "R_Hip": hip_r,
        "L_Knee": knee_l,
        "R_Knee": knee_r,
        "L_Ankle": foot_l,
        "R_Ankle": foot_r,
        "L_Foot": toe_left,
        "R_Foot": toe_right,
        "L_Shoulder": shoulder_l,
        "R_Shoulder": shoulder_r,
        "L_Elbow": elbow_l,
        "R_Elbow": elbow_r,
        "L_Wrist": hand_left,
        "R_Wrist": hand_right,
    }
    return {"bvh": bvh, "optitrack": optitrack, "smpl": smpl}


def build_profile(robot_type: str, urdf_path: Path) -> dict:
    joints, links, edges = _parse_urdf(urdf_path)
    if not joints:
        raise ValueError(f"{urdf_path.name} 里没有可驱动关节")
    feet = {
        "l": _pick(links, "l", "foot", ("ankle_pitch", "ankle_roll", "foot")),
        "r": _pick(links, "r", "foot", ("ankle_pitch", "ankle_roll", "foot")),
    }
    if not feet["l"] or not feet["r"]:
        raise ValueError("URDF 里没有识别到左右脚踝或脚掌连杆，无法生成重定向配置")
    groups = []
    sticking: list[str] = []
    toes: dict[str, str] = {}
    for side, parent in feet.items():
        if not parent:
            continue
        prefix = parent.removesuffix("_link") + "_sphere"
        groups.append({"parent": parent, "name_prefix": prefix, "kind": "foot_pad"})
        toes[side] = f"{prefix}_5_link"
        sticking.extend(f"{prefix}_{index}_link" for index in range(1, 5))
    elbows = {
        "l": _pick(links, "l", "elbow", ("elbow_link", "elbow_pitch", "forearm")),
        "r": _pick(links, "r", "elbow", ("elbow_link", "elbow_pitch", "forearm")),
    }
    hands = {}
    virtual = []
    for side, parent in elbows.items():
        if not parent:
            continue
        name = f"{side}_arm_hand_sphere_link"
        hands[side] = name
        virtual.append({"name": name, "parent": parent, "auto": "aabb_min_z"})
    return {
        "robot_type": robot_type,
        "robot_dof": len(joints),
        "robot_height": round(_estimate_height(links, edges, urdf_path, list(feet.values())), 3),
        "urdf_file": urdf_path.resolve().as_posix(),
        "foot_sticking_links": sticking,
        "virtual_link_groups": groups,
        "virtual_links": virtual,
        "joints_mapping": _mapping(
            links,
            toes.get("l") or feet["l"] or _pick_base(links),
            toes.get("r") or feet["r"] or _pick_base(links),
            hands.get("l") or elbows["l"] or _pick_base(links),
            hands.get("r") or elbows["r"] or _pick_base(links),
        ),
    }


def write_uploaded_profile(hub: Path, robot_type: str, default_rel: str) -> tuple[bool, str]:
    """Write a retarget profile for a newly chosen URDF.

    Returns whether a profile was written, and an error string when it could not be.
    Robots that already have a hand-tuned holosoma entry are left unchanged.
    """
    from .retarget_priority import RETARGETABLE_ROBOTS

    if robot_type in RETARGETABLE_ROBOTS:
        return False, ""
    rel = str(default_rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel.lower().endswith((".urdf", ".xacro")):
        return False, ""
    path = Path(hub) / "3d_model" / "robot" / "standard_description" / robot_type / rel
    if not path.is_file():
        return False, ""
    if path.suffix.lower() == ".xacro":
        return False, "请先把 xacro 展开成 URDF，再设为默认描述文件"
    try:
        write_retarget_profile(hub, robot_type, path)
    except Exception as exc:
        return False, str(exc)
    return True, ""


def write_retarget_profile(hub: Path, robot_type: str, urdf_path: Path) -> Path:
    payload = build_profile(robot_type, urdf_path)
    destination = profile_dir(hub) / f"{robot_type}.json"
    destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return destination


def _package_root(urdf_path: Path) -> Path:
    return urdf_path.parent.parent if urdf_path.parent.name == "urdf" else urdf_path.parent


def _resolve_mesh(raw: str, urdf_path: Path) -> Path | None:
    text = raw.strip()
    root = _package_root(urdf_path)
    if text.startswith("package://"):
        rest = text[len("package://") :]
        rel = rest.split("/", 1)[1] if "/" in rest else rest
        candidate = (root / rel).resolve()
    elif text.startswith("file://"):
        candidate = Path(text[7:])
    else:
        candidate = Path(text) if Path(text).is_absolute() else (urdf_path.parent / text).resolve()
    if candidate.is_file():
        return candidate
    name = Path(text).name
    meshes = root / "meshes"
    if name and meshes.is_dir():
        found = [path for path in meshes.rglob(name) if path.is_file()]
        if len(found) == 1:
            return found[0]
    return None


def _sole_drop(urdf_path: Path, foot_links: list[str]) -> float | None:
    """How far the foot mesh extends below the foot link origin, in meters."""
    try:
        root = ET.parse(urdf_path).getroot()
    except ET.ParseError:
        return None
    wanted = set(foot_links)
    lowest: float | None = None
    for link in root.iter():
        if _local(link.tag) != "link" or link.get("name") not in wanted:
            continue
        for node in link.iter():
            if _local(node.tag) not in {"visual", "collision"}:
                continue
            origin_z = 0.0
            filename = ""
            for child in list(node):
                tag = _local(child.tag)
                if tag == "origin" and child.get("xyz"):
                    parts = child.get("xyz", "").split()
                    if len(parts) == 3:
                        origin_z = float(parts[2])
                if tag == "geometry":
                    for mesh in child.iter():
                        if _local(mesh.tag) == "mesh" and mesh.get("filename"):
                            filename = mesh.get("filename") or ""
            mesh_path = _resolve_mesh(filename, urdf_path) if filename else None
            if mesh_path is None or mesh_path.suffix.lower() != ".stl":
                continue
            mesh_z = _stl_min_z(mesh_path)
            if mesh_z is None:
                continue
            value = origin_z + mesh_z
            lowest = value if lowest is None else min(lowest, value)
    return lowest


def _stl_min_z(path: Path) -> float | None:
    data = path.read_bytes()
    if len(data) < 84:
        return None
    count = struct.unpack_from("<I", data, 80)[0]
    if count <= 0 or 84 + count * 50 > len(data) + 50:
        return None
    lowest: float | None = None
    for index in range(count):
        base = 84 + index * 50 + 12
        for vertex in range(3):
            z = struct.unpack_from("<f", data, base + vertex * 12 + 8)[0]
            lowest = z if lowest is None else min(lowest, z)
    return lowest


def _rewrite_urdf_meshes(urdf_path: Path) -> Path:
    """Point mesh filenames at real files so MuJoCo can compile a ROS URDF."""
    text = urdf_path.read_text(encoding="utf-8", errors="replace")

    def replace(match: re.Match[str]) -> str:
        resolved = _resolve_mesh(match.group(1), urdf_path)
        if resolved is None:
            return match.group(0)
        relative = Path(os.path.relpath(resolved, urdf_path.parent)).as_posix()
        return f'filename="{relative}"'

    rewritten = re.sub(r'filename="([^"]+)"', replace, text)
    destination = urdf_path.with_name(f".{urdf_path.stem}.retarget.urdf")
    destination.write_text(rewritten, encoding="utf-8")
    return destination


def _mjcf_path(urdf_path: Path) -> Path:
    urdf_text = urdf_path.resolve().as_posix()
    marker = "/urdf/"
    if marker not in urdf_text:
        raise ValueError("URDF 必须放在 urdf 目录下，才能生成对应的 mjcf")
    return Path(urdf_text.replace(marker, "/mjcf/", 1)).with_suffix(".xml")


def _mjcf_usable(mjcf: Path) -> bool:
    if not mjcf.is_file():
        return False
    try:
        root = ET.parse(mjcf).getroot()
    except ET.ParseError:
        return False
    compiler = root.find("compiler")
    meshdir_text = compiler.get("meshdir") if compiler is not None else None
    meshdir = Path(meshdir_text) if meshdir_text else mjcf.parent / "meshes"
    if not meshdir.is_absolute():
        meshdir = (mjcf.parent / meshdir).resolve()
    files = [node.get("file") or "" for node in root.iter() if _local(node.tag) == "mesh"]
    files = [name for name in files if name]
    if not files:
        return False
    return all((meshdir / name).is_file() for name in files[:4])


def _pin_meshdir(mjcf: Path, urdf_path: Path) -> None:
    root = ET.parse(mjcf).getroot()
    compiler = root.find("compiler")
    meshdir_text = compiler.get("meshdir") if compiler is not None else None
    meshdir = Path(meshdir_text) if meshdir_text else None
    if meshdir is not None and not meshdir.is_absolute():
        meshdir = (mjcf.parent / meshdir).resolve()
    meshes = [node for node in root.iter() if _local(node.tag) == "mesh" and node.get("file")]
    directories: set[Path] = set()
    for node in meshes:
        raw = Path(node.get("file") or "")
        candidates = [raw] if raw.is_absolute() else []
        if meshdir is not None:
            candidates.append(meshdir / raw.name)
            candidates.append(meshdir / raw)
        candidates.append(mjcf.parent / raw)
        candidates.append(urdf_path.parent / raw)
        resolved = next((path.resolve() for path in candidates if path.is_file()), None)
        if resolved is None:
            continue
        node.set("file", resolved.name)
        directories.add(resolved.parent)
    if compiler is None:
        compiler = ET.Element("compiler")
        root.insert(0, compiler)
    logical_meshes = _package_root(urdf_path) / "meshes"
    if logical_meshes.is_dir():
        compiler.set("meshdir", Path(os.path.relpath(logical_meshes, mjcf.parent)).as_posix())
    elif len(directories) == 1:
        compiler.set("meshdir", next(iter(directories)).as_posix())
    mjcf.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


def _root_link(urdf_path: Path) -> str:
    _joints, links, edges = _parse_urdf(urdf_path)
    children = {child for _parent, child, _xyz in edges}
    parents = [parent for parent, _child, _xyz in edges if parent not in children]
    if parents:
        return parents[0]
    return _pick_base(links)


def _ensure_floating_base(mjcf: Path, urdf_path: Path) -> None:
    """Give the root link a free joint so retargeting can move the pelvis."""
    root = ET.parse(mjcf).getroot()
    world = root.find("worldbody")
    if world is None:
        return
    if any(_local(node.tag) == "freejoint" for node in world.iter()):
        return
    link = _root_link(urdf_path)
    host = next(
        (node for node in list(world) if _local(node.tag) == "body" and node.get("name") == link),
        None,
    )
    if host is None:
        host = ET.Element("body", {"name": link})
        for child in list(world):
            world.remove(child)
            host.append(child)
        world.append(host)
    host.insert(0, ET.Element("freejoint", {"name": "root"}))
    mjcf.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


def _actuated_dof(mjcf: Path) -> int:
    root = ET.parse(mjcf).getroot()
    count = 0
    for node in root.iter():
        if _local(node.tag) != "joint" or not node.get("name"):
            continue
        if (node.get("type") or "hinge") in {"free", "ball"}:
            continue
        count += 1
    return count


def mujoco_python() -> str:
    """Interpreter that can import MuJoCo. Prefers this process, then the retarget env."""
    import sys

    configured = os.environ.get("HOLOSOMA_PYTHON", "").strip()
    candidates = [configured, sys.executable, "/home/noetix/.holosoma_deps/miniconda3/envs/hsretargeting/bin/python"]
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen or not Path(candidate).is_file():
            continue
        seen.add(candidate)
        import subprocess

        proc = subprocess.run([candidate, "-c", "import mujoco"], capture_output=True, text=True, check=False)
        if proc.returncode == 0:
            return candidate
    raise ValueError("没有可用的 MuJoCo，无法从 URDF 生成 MJCF")


def _sole_clearance(urdf_path: Path) -> float:
    """Pelvis height above the sole, used as the standing spawn height."""
    _joints, _links, edges = _parse_urdf(urdf_path)
    heights = _world_z(edges)
    if not heights:
        return 1.0
    base_names = [name for name in heights if _role(name) == "base"]
    foot_names = [name for name in heights if _role(name) in {"foot", "toe"}]
    base_z = heights[base_names[0]] if base_names else max(heights.values())
    foot_z = min((heights[name] for name in foot_names), default=min(heights.values()))
    drop = _sole_drop(urdf_path, foot_names) if foot_names else None
    if drop is not None:
        foot_z += drop
    clearance = abs(base_z - foot_z)
    if clearance < 0.2:
        return 1.0
    return max(0.4, min(1.8, clearance + 0.02))


def _urdf_inertials(urdf_path: Path) -> dict[str, ET.Element]:
    """Link name to a MuJoCo inertial element copied from the URDF."""
    try:
        tree = ET.parse(urdf_path)
    except ET.ParseError:
        return {}
    found: dict[str, ET.Element] = {}
    for link in tree.getroot().iter():
        if _local(link.tag) != "link" or not link.get("name"):
            continue
        inertial = next((node for node in list(link) if _local(node.tag) == "inertial"), None)
        if inertial is None:
            continue
        origin = "0 0 0"
        mass = ""
        inertia = {"ixx": "", "iyy": "", "izz": "", "ixy": "0", "ixz": "0", "iyz": "0"}
        for node in list(inertial):
            tag = _local(node.tag)
            if tag == "origin" and node.get("xyz"):
                origin = node.get("xyz") or origin
            elif tag == "mass" and node.get("value"):
                mass = node.get("value") or ""
            elif tag == "inertia":
                for key in inertia:
                    if node.get(key):
                        inertia[key] = node.get(key) or inertia[key]
        if not mass or not inertia["ixx"]:
            continue
        full = " ".join(inertia[key] for key in ("ixx", "iyy", "izz", "ixy", "ixz", "iyz"))
        found[str(link.get("name"))] = ET.Element(
            "inertial",
            {"pos": origin, "mass": mass, "fullinertia": full},
        )
    return found


def _phc_ready(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return False
    world = root.find("worldbody")
    host = _body_with_freejoint(world) if world is not None else None
    if host is not None and host.find("inertial") is None:
        return False
    return (
        root.find("actuator") is not None
        and root.find(".//site[@name='imu']") is not None
        and root.find(".//geom[@name='ground']") is not None
    )


def _motor_name(joint_name: str, used: set[str]) -> str:
    stem = joint_name[:-6] if joint_name.endswith("_joint") else joint_name
    candidate = stem or joint_name
    if candidate not in used:
        used.add(candidate)
        return candidate
    index = 2
    while f"{candidate}_{index}" in used:
        index += 1
    unique = f"{candidate}_{index}"
    used.add(unique)
    return unique


def _body_with_freejoint(world: ET.Element) -> ET.Element | None:
    for body in world.iter():
        if _local(body.tag) != "body":
            continue
        if any(_local(child.tag) == "freejoint" for child in list(body)):
            return body
    return None


def _apply_phc_scene(mjcf: Path, urdf_path: Path) -> None:
    """Add the scene, joint, motor and IMU pieces used by the PHC robot MJCFs."""
    root = ET.parse(mjcf).getroot()
    compiler = root.find("compiler")
    default = root.find("default")
    if default is None:
        default = ET.Element("default")
        if compiler is not None:
            index = list(root).index(compiler) + 1
            root.insert(index, default)
        else:
            root.insert(0, default)
    if default.find("joint") is None:
        default.append(
            ET.Element(
                "joint",
                {"damping": "0.001", "armature": "0.005", "frictionloss": "0.1"},
            )
        )

    asset = root.find("asset")
    if asset is None:
        asset = ET.Element("asset")
        root.append(asset)
    if not any(node.get("type") == "skybox" for node in asset if _local(node.tag) == "texture"):
        asset.append(
            ET.Element(
                "texture",
                {
                    "type": "skybox",
                    "builtin": "gradient",
                    "rgb1": "0.3 0.5 0.7",
                    "rgb2": "0 0 0",
                    "width": "512",
                    "height": "512",
                },
            )
        )
    if asset.find("texture[@name='texplane']") is None:
        asset.append(
            ET.Element(
                "texture",
                {
                    "name": "texplane",
                    "type": "2d",
                    "builtin": "checker",
                    "rgb1": ".2 .3 .4",
                    "rgb2": ".1 0.15 0.2",
                    "width": "512",
                    "height": "512",
                    "mark": "cross",
                    "markrgb": ".8 .8 .8",
                },
            )
        )
    if asset.find("material[@name='matplane']") is None:
        asset.append(
            ET.Element(
                "material",
                {
                    "name": "matplane",
                    "reflectance": "0.",
                    "texture": "texplane",
                    "texrepeat": "1 1",
                    "texuniform": "true",
                },
            )
        )

    inertials = _urdf_inertials(urdf_path)
    for body in list(root.iter()):
        if _local(body.tag) != "body" or body.find("inertial") is not None:
            continue
        inertial = inertials.get(body.get("name") or "")
        if inertial is not None:
            body.insert(0, inertial)

    for body in root.iter():
        if _local(body.tag) != "body" or body.find("inertial") is None:
            continue
        for geom in list(body):
            if _local(geom.tag) != "geom":
                continue
            if geom.get("name") == "ground" or geom.get("type") == "plane":
                continue
            if geom.get("mesh") or geom.get("type") == "mesh":
                geom.set("contype", "0")
                geom.set("conaffinity", "0")
                geom.set("group", "1")
                geom.set("density", "0")

    world = root.find("worldbody")
    if world is not None and world.find("geom[@name='ground']") is None:
        lights = [
            ET.Element(
                "light",
                {
                    "directional": "true",
                    "diffuse": ".4 .4 .4",
                    "specular": "0.1 0.1 0.1",
                    "pos": "0 0 5.0",
                    "dir": "0 0 -1",
                    "castshadow": "false",
                },
            ),
            ET.Element(
                "light",
                {
                    "directional": "true",
                    "diffuse": ".6 .6 .6",
                    "specular": "0.2 0.2 0.2",
                    "pos": "0 0 4",
                    "dir": "0 0 -1",
                },
            ),
            ET.Element(
                "geom",
                {
                    "name": "ground",
                    "type": "plane",
                    "size": "0 0 1",
                    "pos": "0.001 0 0",
                    "quat": "1 0 0 0",
                    "material": "matplane",
                    "condim": "1",
                    "conaffinity": "15",
                },
            ),
        ]
        for offset, node in enumerate(lights):
            world.insert(offset, node)

    if world is not None:
        host = _body_with_freejoint(world)
        if host is not None:
            for joint in host.iter():
                if _local(joint.tag) == "freejoint":
                    joint.set("name", "root")
            if host.find("site[@name='imu']") is None:
                host.append(ET.Element("site", {"name": "imu", "size": "0.01", "pos": "0 0 0"}))
            parts = (host.get("pos") or "0 0 0").split()
            if len(parts) != 3:
                parts = ["0", "0", "0"]
            try:
                height = float(parts[2])
            except ValueError:
                height = 0.0
            if abs(height) < 0.05:
                parts[2] = f"{_sole_clearance(urdf_path):.3f}"
                host.set("pos", " ".join(parts))

    if root.find("actuator") is None:
        actuator = ET.Element("actuator")
        used: set[str] = set()
        for joint in root.iter():
            if _local(joint.tag) != "joint":
                continue
            if (joint.get("type") or "hinge") in {"free", "ball"}:
                continue
            name = joint.get("name")
            if not name:
                continue
            actuator.append(ET.Element("motor", {"name": _motor_name(name, used), "joint": name}))
        if list(actuator):
            root.append(actuator)

    if root.find("sensor") is None and root.find(".//site[@name='imu']") is not None:
        sensor = ET.Element("sensor")
        sensor.append(ET.Element("framequat", {"name": "orientation", "objtype": "site", "noise": "0.001", "objname": "imu"}))
        sensor.append(ET.Element("framepos", {"name": "position", "objtype": "site", "noise": "0.001", "objname": "imu"}))
        sensor.append(ET.Element("gyro", {"name": "angular-velocity", "site": "imu", "noise": "0.005", "cutoff": "34.9"}))
        sensor.append(ET.Element("velocimeter", {"name": "linear-velocity", "site": "imu", "noise": "0.001", "cutoff": "30"}))
        sensor.append(ET.Element("accelerometer", {"name": "linear-acceleration", "site": "imu", "noise": "0.005", "cutoff": "157"}))
        sensor.append(ET.Element("magnetometer", {"name": "magnetometer", "site": "imu"}))
        root.append(sensor)

    ET.indent(root, space="  ")
    mjcf.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


def compile_mjcf(urdf_path: Path, python: str) -> Path:
    """Compile URDF to the MJCF path holosoma derives by swapping /urdf/ for /mjcf/."""
    mjcf = _mjcf_path(urdf_path)
    mjcf.parent.mkdir(parents=True, exist_ok=True)
    fresh = (
        _mjcf_usable(mjcf)
        and _phc_ready(mjcf)
        and mjcf.stat().st_mtime >= urdf_path.stat().st_mtime
    )
    if fresh:
        return mjcf
    if not _mjcf_usable(mjcf) or mjcf.stat().st_mtime < urdf_path.stat().st_mtime:
        rewritten = _rewrite_urdf_meshes(urdf_path)
        script = (
            "import mujoco, pathlib, sys\n"
            "urdf, mjcf = sys.argv[1:]\n"
            "model = mujoco.MjModel.from_xml_path(urdf)\n"
            "pathlib.Path(mjcf).parent.mkdir(parents=True, exist_ok=True)\n"
            "mujoco.mj_saveLastXML(mjcf, model)\n"
        )
        import subprocess

        try:
            proc = subprocess.run(
                [python, "-c", script, rewritten.resolve().as_posix(), mjcf.as_posix()],
                cwd=str(urdf_path.parent),
                env={**os.environ, "TMPDIR": "/tmp"},
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            rewritten.unlink(missing_ok=True)
        if proc.returncode != 0 or not mjcf.is_file():
            detail = (proc.stderr or proc.stdout or "MuJoCo 没有写出 MJCF").strip().splitlines()[-1]
            raise RuntimeError(detail)
        _pin_meshdir(mjcf, urdf_path)
    _ensure_floating_base(mjcf, urdf_path)
    _apply_phc_scene(mjcf, urdf_path)
    if not _mjcf_usable(mjcf):
        raise RuntimeError(f"{mjcf.name} 已生成，但网格路径无法解析")
    return mjcf


def _package_file_count(directory: Path) -> int:
    if not directory.is_dir():
        return 0
    return sum(1 for path in directory.rglob("*") if path.is_file() and not path.name.startswith("."))


def fill_missing_mjcf(package: Path, default_rel: str = "") -> list[str]:
    """Create mjcf from the URDF when that directory is missing, empty, or still a raw compile.

    meshes and urdf must already contain files. Returns the new MJCF paths
    relative to the package, or an empty list when a finished MJCF is already present.
    """
    if _package_file_count(package / "meshes") == 0 or _package_file_count(package / "urdf") == 0:
        return []
    urdf = choose_urdf(package, default_rel)
    if urdf is None:
        if _package_file_count(package / "mjcf") == 0:
            raise ValueError("mjcf 为空，请选择一个 URDF 作为默认描述文件，以便自动生成")
        return []
    if urdf.suffix.lower() == ".xacro":
        raise ValueError("请先把 xacro 展开成 URDF，再用来生成 MJCF")
    target = _mjcf_path(urdf)
    others = [
        path
        for path in (package / "mjcf").rglob("*.xml")
        if path.is_file() and path.resolve() != target.resolve()
    ] if (package / "mjcf").is_dir() else []
    if _phc_ready(target) or (others and not target.is_file()):
        return []
    (package / "mjcf").mkdir(parents=True, exist_ok=True)
    try:
        written = compile_mjcf(urdf, mujoco_python())
    except (RuntimeError, ValueError, OSError) as exc:
        raise ValueError(f"无法从 {urdf.name} 生成 MJCF：{exc}") from exc
    return [written.resolve().relative_to(package.resolve()).as_posix()]


def ensure_retarget_profile(hub: Path, robot_type: str, *, python: str) -> Path | None:
    """Write the profile and MJCF for an uploaded robot. Built-in robots are left alone."""
    from .retarget_priority import RETARGETABLE_ROBOTS

    if robot_type in RETARGETABLE_ROBOTS:
        return None
    instance = Path(hub) / "3d_model" / "robot" / "standard_description" / robot_type
    urdf = choose_urdf(instance)
    if urdf is None:
        return None
    written = profile_dir(hub) / f"{robot_type}.json"
    if not written.is_file():
        written = write_retarget_profile(hub, robot_type, urdf)
    mjcf = compile_mjcf(urdf, python)
    dof = _actuated_dof(mjcf)
    if dof and written.is_file():
        payload = json.loads(written.read_text(encoding="utf-8"))
        if int(payload.get("robot_dof") or 0) != dof:
            payload["robot_dof"] = dof
            tmp = written.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(written)
    return written
