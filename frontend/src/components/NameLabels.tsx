import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { rigidMarkerKey } from "../captureLabels";

/** 三维预览里三类名称的开关。没打开时不画字。所有窗口共用这一组选择。 */
export type NameFlags = {
  skeleton: boolean;
  object: boolean;
  joint: boolean;
};

export const NAMES_OFF: NameFlags = { skeleton: false, object: false, joint: false };

const NAME_STORAGE = "viz-name-flags";
const nameListeners = new Set<() => void>();

function readNameFlags(): NameFlags {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAME_STORAGE) || "");
    return {
      skeleton: Boolean(parsed.skeleton),
      object: Boolean(parsed.object),
      joint: Boolean(parsed.joint),
    };
  } catch {
    return NAMES_OFF;
  }
}

let nameFlags = readNameFlags();

function writeNameFlags(next: NameFlags) {
  nameFlags = next;
  localStorage.setItem(NAME_STORAGE, JSON.stringify(next));
  nameListeners.forEach((listener) => listener());
}

export function useNameFlags(): [NameFlags, (kind: keyof NameFlags, on: boolean) => void] {
  const [flags, setFlags] = useState(nameFlags);
  useEffect(() => {
    const listener = () => setFlags(nameFlags);
    nameListeners.add(listener);
    return () => {
      nameListeners.delete(listener);
    };
  }, []);
  const setOne = (kind: keyof NameFlags, on: boolean) => writeNameFlags({ ...nameFlags, [kind]: on });
  return [flags, setOne];
}

const NAME_TOGGLE_ITEMS: { kind: keyof NameFlags; label: string; title: string }[] = [
  { kind: "skeleton", label: "骨架名称", title: "显示人体骨架的名字" },
  { kind: "object", label: "刚体名称", title: "显示刚体、桌子等物体的名字" },
  { kind: "joint", label: "关节名称", title: "一直显示全部关节名。鼠标靠近时也会显示当前关节或标记点" },
];

/** 放在每个三维预览的播放条上。 */
export function NameToggleButtons() {
  const [flags, setFlag] = useNameFlags();
  return (
    <span className="viz-name-toggles">
      {NAME_TOGGLE_ITEMS.map((item) => (
        <button
          key={item.kind}
          type="button"
          className={`follow-root-toggle secondary${flags[item.kind] ? " is-on" : ""}`}
          aria-pressed={flags[item.kind]}
          title={item.title}
          onClick={() => setFlag(item.kind, !flags[item.kind])}
        >
          {item.label}
        </button>
      ))}
    </span>
  );
}

const SMPL_JOINTS = [
  "Pelvis",
  "L_Hip",
  "R_Hip",
  "Spine1",
  "L_Knee",
  "R_Knee",
  "Spine2",
  "L_Ankle",
  "R_Ankle",
  "Spine3",
  "L_Foot",
  "R_Foot",
  "Neck",
  "L_Collar",
  "R_Collar",
  "Head",
  "L_Shoulder",
  "R_Shoulder",
  "L_Elbow",
  "R_Elbow",
  "L_Wrist",
  "R_Wrist",
  "L_Hand",
  "R_Hand",
];

const FLOATING_JOINT = /floor_2_base|floating_base|floatingbase|root_joint|base_joint|world_to_/i;
function isEndSite(name: string) {
  return /end$/i.test(name) && /(toe|thumb|index|middle|ring|pinky|head|site)/i.test(name);
}

type Anchor = {
  target: THREE.Object3D;
  text: string;
  kind: keyof NameFlags;
};

type UrdfRobot = THREE.Object3D & {
  joints: Record<string, THREE.Object3D>;
  setJointValue: (name: string, value: number) => unknown;
};

function rawName(obj: THREE.Object3D) {
  return String(obj.userData.originalName || obj.name || "").trim();
}

function cleaned(name: string) {
  return name.toLowerCase().replace(/[:\s]+/g, "_");
}

function isUrdfRobot(obj: THREE.Object3D): obj is UrdfRobot {
  const robot = obj as Partial<UrdfRobot>;
  return typeof robot.setJointValue === "function" && !!robot.joints && typeof robot.joints === "object";
}

function underRobot(obj: THREE.Object3D) {
  let current: THREE.Object3D | null = obj;
  while (current) {
    if (isUrdfRobot(current)) return true;
    current = current.parent;
  }
  return false;
}

/** Motive 骨架是「Skeleton 001_LeftArm」。前半是骨架名，后半是关节名。 */
function splitSkeletonJoint(name: string) {
  const match = name.match(/^(?:c3d[:_\s]*)?(skeleton[_ \d]*\d+)[_:\s]+(.+)$/i);
  if (!match) return { skeleton: null as string | null, joint: name };
  return {
    skeleton: match[1].replace(/_+/g, " ").replace(/\s+/g, " ").trim(),
    joint: match[2],
  };
}

function boneDepth(bone: THREE.Object3D) {
  let depth = 0;
  let parent = bone.parent;
  while (parent) {
    depth += 1;
    parent = parent.parent;
  }
  return depth;
}

function sceneSignature(root: THREE.Object3D) {
  let bones = 0;
  let robots = 0;
  let named = 0;
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) bones += 1;
    if (isUrdfRobot(obj)) robots += 1;
    if (obj.userData.nameKind) named += 1;
  });
  return `${root.uuid}:${bones}:${robots}:${named}`;
}

function collectNameAnchors(root: THREE.Object3D, names: NameFlags): Anchor[] {
  const anchors: Anchor[] = [];

  root.traverse((obj) => {
    if (!isUrdfRobot(obj)) return;
    if (names.skeleton) {
      anchors.push({ target: obj, text: rawName(obj) || "机器人", kind: "skeleton" });
    }
    if (!names.joint) return;
    for (const [name, joint] of Object.entries(obj.joints)) {
      if (!joint || FLOATING_JOINT.test(name)) continue;
      anchors.push({ target: joint, text: name, kind: "joint" });
    }
  });

  if (names.skeleton || names.joint) {
    const groups = new Map<string, { bone: THREE.Bone; joint: string; depth: number }[]>();
    root.traverse((obj) => {
      if (!(obj as THREE.Bone).isBone) return;
      const name = rawName(obj);
      if (!name || name.startsWith("__")) return;
      if (/(_bone|_root)$/i.test(name) && !/skeleton/i.test(name)) return;
      const parts = splitSkeletonJoint(name);
      if (!parts.joint || isEndSite(parts.joint)) return;
      const key = parts.skeleton ?? "__plain__";
      const list = groups.get(key) ?? [];
      list.push({ bone: obj as THREE.Bone, joint: parts.joint, depth: boneDepth(obj) });
      groups.set(key, list);
    });
    for (const [key, list] of groups) {
      const hips =
        list.find((item) => /^(hips|hip|pelvis)$/i.test(item.joint)) ??
        list.reduce((best, item) => (item.depth < best.depth ? item : best));
      const skeletonText = key === "__plain__" ? hips.joint : key;
      if (names.skeleton) anchors.push({ target: hips.bone, text: skeletonText, kind: "skeleton" });
      if (!names.joint) continue;
      for (const item of list) {
        if (names.skeleton && item.bone === hips.bone && item.joint === skeletonText) continue;
        anchors.push({ target: item.bone, text: item.joint, kind: "joint" });
      }
    }
  }

  if (names.object) {
    const markers = new Map<string, THREE.Object3D>();
    root.traverse((obj) => {
      const key = rigidMarkerKey(rawName(obj));
      if (key && !markers.has(key)) markers.set(key, obj);
    });
    const labeled = new Set<string>();
    root.traverse((obj) => {
      const name = rawName(obj);
      if (!name || name.startsWith("__") || (obj as THREE.Bone).isBone || underRobot(obj)) return;
      const kind = obj.userData.nameKind;
      if (kind === "marker") return;
      if (kind === "rigid") {
        labeled.add(cleaned(name));
        anchors.push({ target: obj, text: name, kind: "object" });
        return;
      }
      const token = cleaned(name);
      if (/(_root|_bone)$/.test(token) || token === "marker_null_root" || /optical$/.test(token)) return;
      if (rigidMarkerKey(name)) return;
      const rigid =
        markers.has(token) ||
        /rigid_?body_?\d+$/.test(token) ||
        /rigidbody_?\d+$/.test(token) ||
        /(^|_)table$/.test(token) ||
        /刚体/.test(name);
      if (!rigid) return;
      labeled.add(token);
      anchors.push({ target: obj, text: name, kind: "object" });
    });
    for (const [key, marker] of markers) {
      if (labeled.has(key)) continue;
      const text = String(marker.userData.rigidLabel || key.replace(/_+/g, " "));
      anchors.push({ target: marker, text, kind: "object" });
    }
  }

  return anchors;
}

function FollowLabel({ target, text, kind }: Anchor) {
  const group = useRef<THREE.Group>(null);
  const world = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const node = group.current;
    const parent = node?.parent;
    if (!node || !parent) return;
    target.getWorldPosition(world);
    parent.worldToLocal(world);
    node.position.copy(world);
  });
  return (
    <group ref={group}>
      <Html center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
        <span className={`viz-name-label is-${kind}`}>{text}</span>
      </Html>
    </group>
  );
}

/** 跟着骨架、机器人、刚体一起动的名称。root 换成新场景时会重新找一遍。 */
export function SceneNameLabels({ root, names }: { root: THREE.Object3D | null; names: NameFlags }) {
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const signature = useRef("");
  useFrame(() => {
    const enabled = names.skeleton || names.object || names.joint;
    if (!root || !enabled) {
      if (signature.current) {
        signature.current = "";
        setAnchors([]);
      }
      return;
    }
    const next = `${sceneSignature(root)}|${names.skeleton ? 1 : 0}${names.object ? 1 : 0}${names.joint ? 1 : 0}`;
    if (next === signature.current) return;
    signature.current = next;
    setAnchors(collectNameAnchors(root, names));
  });
  return (
    <>
      {anchors.map((anchor) => (
        <FollowLabel
          key={`${anchor.kind}:${anchor.target.uuid}:${anchor.text}`}
          target={anchor.target}
          text={anchor.text}
          kind={anchor.kind}
        />
      ))}
    </>
  );
}

/** SMPL 关节没有骨骼节点，名称直接跟算出的关节点。 */
export function SmplNameLabels({
  positions,
  names,
  skeletonName,
}: {
  positions: THREE.Vector3[];
  names: NameFlags;
  skeletonName: string;
}) {
  const joints = useRef<(THREE.Group | null)[]>([]);
  const skeleton = useRef<THREE.Group>(null);
  useFrame(() => {
    positions.forEach((point, index) => {
      const node = joints.current[index];
      if (node) node.position.copy(point);
    });
    if (skeleton.current && positions[0]) skeleton.current.position.copy(positions[0]);
  });
  if (!names.skeleton && !names.joint) return null;
  return (
    <>
      {names.skeleton && (
        <group ref={skeleton}>
          <Html center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
            <span className="viz-name-label is-skeleton">{skeletonName}</span>
          </Html>
        </group>
      )}
      {names.joint &&
        SMPL_JOINTS.map((name, index) => (
          <group
            key={name}
            ref={(node) => {
              joints.current[index] = node;
            }}
          >
            <Html center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
              <span className="viz-name-label is-joint">{name}</span>
            </Html>
          </group>
        ))}
    </>
  );
}
