import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Html, OrbitControls } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { getToken } from "../api";

const _bvhHips = new THREE.Vector3();
const _bvhBox = new THREE.Box3();
const _bvhPt = new THREE.Vector3();

async function fetchBinary(url: string) {
  const token = getToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`文件下载失败（${res.status}）`);
  return res.arrayBuffer();
}

export function BvhScene({
  url,
  time,
  duration,
  onDuration,
}: {
  url: string;
  time: number;
  duration: number;
  onDuration?: (sec: number) => void;
}) {
  const { scene } = useThree();
  const centerRef = useRef<THREE.Group>(null);
  const boneRootRef = useRef<THREE.Bone | null>(null);
  const helperRef = useRef<THREE.SkeletonHelper | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  const fixedOffset = useRef(new THREE.Vector3());
  const offsetReady = useRef(false);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const [boneRoot, setBoneRoot] = useState<THREE.Bone | null>(null);
  const [scale, setScale] = useState(0.01);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setBoneRoot(null);
    boneRootRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
    if (helperRef.current) {
      scene.remove(helperRef.current);
      helperRef.current.geometry.dispose();
      (helperRef.current.material as THREE.Material).dispose();
      helperRef.current = null;
    }

    const loader = new BVHLoader();
    fetchBinary(url)
      .then((buf) => {
        if (cancelled) return;
        const text = new TextDecoder().decode(buf);
        if (!/HIERARCHY/i.test(text) || !/MOTION/i.test(text)) {
          throw new Error("不是有效的 BVH 文件");
        }
        const result = loader.parse(text);
        const bone0 = result.skeleton?.bones?.[0];
        if (!bone0) throw new Error("BVH 中没有骨骼根节点");

        if (bone0.parent) bone0.parent.remove(bone0);

        const probeMixer = new THREE.AnimationMixer(bone0);
        const probeAction = probeMixer.clipAction(result.clip);
        probeAction.play();
        probeAction.paused = true;

        const clipDur = result.clip.duration || 1;
        let sumX = 0;
        let sumZ = 0;
        let samples = 0;
        let minY = Infinity;
        let maxHeight = 0;
        const n = 24;
        for (let i = 0; i < n; i++) {
          probeAction.time = (i / Math.max(n - 1, 1)) * clipDur;
          probeMixer.update(0);
          bone0.updateMatrixWorld(true);
          bone0.getWorldPosition(_bvhHips);
          sumX += _bvhHips.x;
          sumZ += _bvhHips.z;
          samples++;
          _bvhBox.makeEmpty();
          bone0.traverse((obj) => {
            if ((obj as THREE.Bone).isBone) {
              obj.getWorldPosition(_bvhPt);
              _bvhBox.expandByPoint(_bvhPt);
            }
          });
          if (!_bvhBox.isEmpty()) {
            minY = Math.min(minY, _bvhBox.min.y);
            maxHeight = Math.max(maxHeight, _bvhBox.max.y - _bvhBox.min.y);
          }
        }
        const meanX = samples ? sumX / samples : 0;
        const meanZ = samples ? sumZ / samples : 0;
        if (!Number.isFinite(minY)) minY = 0;
        const nextScale = maxHeight > 8 ? 0.01 : 1;
        fixedOffset.current.set(
          -meanX * nextScale,
          -minY * nextScale,
          -meanZ * nextScale
        );
        offsetReady.current = true;

        // Radius is in BVH local units. A fixed 2.2 worked for centimetre
        // files but swallowed metre-scale skeletons (height ≈ 1–2).
        const jointRadius = Math.max(maxHeight * 0.016, 0.002);
        const jointGeo = new THREE.SphereGeometry(jointRadius, 10, 10);
        const jointMat = new THREE.MeshStandardMaterial({
          color: 0xffb454,
          emissive: 0x663300,
          roughness: 0.55,
        });
        bone0.traverse((obj) => {
          if (!(obj as THREE.Bone).isBone) return;
          const dot = new THREE.Mesh(jointGeo, jointMat);
          dot.name = "__bvh_joint_dot";
          obj.add(dot);
        });

        const helper = new THREE.SkeletonHelper(bone0);
        const mat = helper.material as THREE.LineBasicMaterial;
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.transparent = true;
        mat.opacity = 1;
        helper.frustumCulled = false;
        scene.add(helper);
        helperRef.current = helper;

        boneRootRef.current = bone0;
        mixer.current = probeMixer;
        action.current = probeAction;
        if (clipDur > 0) onDurationRef.current?.(clipDur);
        setScale(nextScale);
        setBoneRoot(bone0);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error(e);
        setStatus("error");
        setError(e instanceof Error ? e.message : "BVH 加载失败");
      });

    return () => {
      cancelled = true;
      if (helperRef.current) {
        scene.remove(helperRef.current);
        helperRef.current.geometry.dispose();
        (helperRef.current.material as THREE.Material).dispose();
        helperRef.current = null;
      }
      const bone = boneRootRef.current;
      if (bone) {
        let disposedGeo: THREE.BufferGeometry | null = null;
        let disposedMat: THREE.Material | null = null;
        bone.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.name !== "__bvh_joint_dot") return;
          if (mesh.parent) mesh.parent.remove(mesh);
          if (mesh.geometry && mesh.geometry !== disposedGeo) {
            disposedGeo = mesh.geometry;
            disposedGeo.dispose();
          }
          if (mesh.material && mesh.material !== disposedMat) {
            disposedMat = mesh.material as THREE.Material;
            disposedMat.dispose();
          }
        });
      }
    };
  }, [url, scene]);

  useFrame(() => {
    const center = centerRef.current;
    if (!mixer.current || !action.current || !center) return;

    const clipDur = action.current.getClip().duration || duration || 1;
    action.current.time = Math.min(Math.max(time, 0), clipDur);
    mixer.current.update(0);
    if (offsetReady.current) {
      center.position.copy(fixedOffset.current);
    }
  });

  return (
    <group>
      <group ref={centerRef}>
        {boneRoot && (
          <group scale={scale}>
            <primitive object={boneRoot} />
          </group>
        )}
      </group>
      {status === "loading" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="muted animation-format-status">BVH 加载中…</div>
        </Html>
      )}
      {status === "error" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="error animation-format-status">{error || "BVH 可视化失败"}</div>
        </Html>
      )}
    </group>
  );
}

function expandSkeletonBox(root: THREE.Object3D, box: THREE.Box3) {
  box.makeEmpty();
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      obj.getWorldPosition(_bvhPt);
      box.expandByPoint(_bvhPt);
    }
  });
  if (box.isEmpty()) {
    box.setFromObject(root);
  }
}

function styleSkeletonHelper(helper: THREE.SkeletonHelper) {
  const mat = helper.material as THREE.LineBasicMaterial;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.transparent = true;
  mat.opacity = 1;
  helper.frustumCulled = false;
  return helper;
}

function attachJointDots(root: THREE.Object3D, height: number) {
  const jointRadius = Math.max(height * 0.016, 0.002);
  const jointGeo = new THREE.SphereGeometry(jointRadius, 10, 10);
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0xffb454,
    emissive: 0x663300,
    roughness: 0.55,
  });
  root.traverse((obj) => {
    if (!(obj as THREE.Bone).isBone) return;
    const dot = new THREE.Mesh(jointGeo, jointMat);
    dot.name = "__joint_dot";
    obj.add(dot);
  });
}

function detachJointDots(root: THREE.Object3D | null) {
  if (!root) return;
  let disposedGeo: THREE.BufferGeometry | null = null;
  let disposedMat: THREE.Material | null = null;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.name !== "__joint_dot") return;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry && mesh.geometry !== disposedGeo) {
      disposedGeo = mesh.geometry;
      disposedGeo.dispose();
    }
    if (mesh.material && mesh.material !== disposedMat) {
      disposedMat = mesh.material as THREE.Material;
      disposedMat.dispose();
    }
  });
}

export function FbxScene({
  url,
  time,
  duration = 1,
  onDuration,
}: {
  url: string;
  time: number;
  duration?: number;
  onDuration?: (sec: number) => void;
}) {
  const { scene } = useThree();
  const centerRef = useRef<THREE.Group>(null);
  const objectRef = useRef<THREE.Group | null>(null);
  const helperRef = useRef<THREE.SkeletonHelper | null>(null);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const action = useRef<THREE.AnimationAction | null>(null);
  const fixedOffset = useRef(new THREE.Vector3());
  const offsetReady = useRef(false);
  const onDurationRef = useRef(onDuration);
  onDurationRef.current = onDuration;
  const [object, setObject] = useState<THREE.Group | null>(null);
  const [scale, setScale] = useState(0.01);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setObject(null);
    objectRef.current = null;
    mixer.current = null;
    action.current = null;
    offsetReady.current = false;
    fixedOffset.current.set(0, 0, 0);
    if (helperRef.current) {
      scene.remove(helperRef.current);
      helperRef.current.geometry.dispose();
      (helperRef.current.material as THREE.Material).dispose();
      helperRef.current = null;
    }

    const loader = new FBXLoader();
    fetchBinary(url)
      .then((buf) => {
        if (cancelled) return;
        const obj = loader.parse(buf, "");
        let meshCount = 0;
        let boneCount = 0;
        obj.traverse((item) => {
          if ((item as THREE.Bone).isBone) boneCount += 1;
          const mesh = item as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry?.attributes?.position?.count) {
            meshCount += 1;
          }
        });
        if (!boneCount && !meshCount) {
          throw new Error("FBX 中没有可显示的网格或骨骼");
        }

        const clip = obj.animations?.[0];
        const probeMixer = clip ? new THREE.AnimationMixer(obj) : null;
        const probeAction = clip && probeMixer ? probeMixer.clipAction(clip) : null;
        if (probeAction && probeMixer) {
          probeAction.play();
          probeAction.paused = true;
        }

        const clipDur = clip?.duration || 1;
        let sumX = 0;
        let sumZ = 0;
        let samples = 0;
        let minY = Infinity;
        let maxHeight = 0;
        const n = probeAction && probeMixer ? 24 : 1;
        for (let i = 0; i < n; i++) {
          if (probeAction && probeMixer) {
            probeAction.time = (i / Math.max(n - 1, 1)) * clipDur;
            probeMixer.update(0);
          }
          expandSkeletonBox(obj, _bvhBox);
          if (_bvhBox.isEmpty()) continue;
          const mid = _bvhBox.getCenter(_bvhHips);
          sumX += mid.x;
          sumZ += mid.z;
          samples += 1;
          minY = Math.min(minY, _bvhBox.min.y);
          maxHeight = Math.max(maxHeight, _bvhBox.max.y - _bvhBox.min.y);
        }
        const meanX = samples ? sumX / samples : 0;
        const meanZ = samples ? sumZ / samples : 0;
        if (!Number.isFinite(minY)) minY = 0;
        const nextScale = maxHeight > 8 ? 0.01 : 1;
        fixedOffset.current.set(
          -meanX * nextScale,
          -minY * nextScale,
          -meanZ * nextScale
        );
        offsetReady.current = true;

        if (boneCount && !meshCount) {
          attachJointDots(obj, maxHeight || 1);
        }
        if (boneCount) {
          const helper = styleSkeletonHelper(new THREE.SkeletonHelper(obj));
          scene.add(helper);
          helperRef.current = helper;
        }

        objectRef.current = obj;
        mixer.current = probeMixer;
        action.current = probeAction;
        if (clip && clip.duration > 0) onDurationRef.current?.(clip.duration);
        setScale(nextScale);
        setObject(obj);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error(e);
        setStatus("error");
        setError(e instanceof Error ? e.message : "FBX 加载失败");
      });

    return () => {
      cancelled = true;
      if (helperRef.current) {
        scene.remove(helperRef.current);
        helperRef.current.geometry.dispose();
        (helperRef.current.material as THREE.Material).dispose();
        helperRef.current = null;
      }
      detachJointDots(objectRef.current);
    };
  }, [url, scene]);

  useFrame(() => {
    const center = centerRef.current;
    if (mixer.current && action.current) {
      const clipDur = action.current.getClip().duration || duration || 1;
      action.current.time = Math.min(Math.max(time, 0), clipDur);
      mixer.current.update(0);
    }
    if (center && offsetReady.current) {
      center.position.copy(fixedOffset.current);
    }
  });

  return (
    <group>
      <group ref={centerRef}>
        {object && (
          <group scale={scale}>
            <primitive object={object} />
          </group>
        )}
      </group>
      {status === "loading" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="muted animation-format-status">FBX 加载中…</div>
        </Html>
      )}
      {status === "error" && (
        <Html center style={{ pointerEvents: "none" }}>
          <div className="error animation-format-status">{error || "FBX 可视化失败"}</div>
        </Html>
      )}
    </group>
  );
}

export function animationFormatOf(file: { format?: string; name?: string }) {
  const fmt = (file.format || "").toLowerCase().replace(/^\./, "");
  const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
  if (fmt === "bvh" || ext === "bvh") return "bvh";
  if (fmt === "fbx" || ext === "fbx") return "fbx";
  return null;
}

export function AnimationFormatPreview({
  url,
  format,
  durationHint,
}: {
  url: string;
  format: "bvh" | "fbx";
  durationHint?: number | null;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const duration = mediaDuration || durationHint || 1;

  useEffect(() => {
    setTime(0);
    setPlaying(true);
    setMediaDuration(0);
  }, [url]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      setTime((current) => {
        const next = current + dt;
        return next > duration ? 0 : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration, speed]);

  return (
    <div
      className="animation-format-preview"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="viewer-panel animation-format-canvas">
        <Canvas camera={{ position: [2.4, 1.8, 3.2], fov: 50 }}>
          <color attach="background" args={["#0b0d12"]} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[3, 5, 2]} intensity={1.1} />
          <Grid args={[10, 10]} cellColor="#334" sectionColor="#556" fadeDistance={20} />
          {format === "bvh" ? (
            <BvhScene
              url={url}
              time={time}
              duration={duration}
              onDuration={setMediaDuration}
            />
          ) : (
            <FbxScene
              url={url}
              time={time}
              duration={duration}
              onDuration={setMediaDuration}
            />
          )}
          <OrbitControls makeDefault />
        </Canvas>
      </div>
      <div className="playback-controls animation-format-controls">
        <button
          type="button"
          className="play-button"
          onClick={() => setPlaying((current) => !current)}
          title={playing ? "暂停" : "播放"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            setPlaying(false);
            setTime(0);
          }}
          title="回到开始"
        >
          ⏮
        </button>
        <span className="frame-readout muted">
          {time.toFixed(2)}s / {duration.toFixed(2)}s
        </span>
        <input
          className="timeline-slider"
          type="range"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(time, duration)}
          onChange={(event) => {
            setPlaying(false);
            setTime(Number(event.target.value));
          }}
        />
        <select
          className="speed-select"
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
          title="倍速"
        >
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={1.5}>1.5×</option>
          <option value={2}>2×</option>
        </select>
      </div>
    </div>
  );
}
