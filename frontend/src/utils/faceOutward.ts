import * as THREE from "three";

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _center = new THREE.Vector3();

/** 箱子网格经常朝内绕。从外面看时近处的面被剔掉，只剩内壁，像个透明盒子。翻到朝外再算法线。 */
export function faceMeshOutward(geometry: THREE.BufferGeometry) {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos?.count) return;
  geometry.computeBoundingBox();
  geometry.boundingBox?.getCenter(_center);
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const read = (slot: number, target: THREE.Vector3) => {
    target.fromBufferAttribute(pos, index ? index.getX(slot) : slot);
  };
  let score = 0;
  for (let tri = 0; tri < triCount; tri += 1) {
    read(tri * 3, _a);
    read(tri * 3 + 1, _b);
    read(tri * 3 + 2, _c);
    _ab.subVectors(_b, _a);
    _ac.subVectors(_c, _a);
    _n.crossVectors(_ab, _ac);
    _mid.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3).sub(_center);
    score += Math.sign(_n.dot(_mid));
  }
  if (score < 0) {
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const second = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, second);
      }
      index.needsUpdate = true;
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        const x = pos.getX(i + 1);
        const y = pos.getY(i + 1);
        const z = pos.getZ(i + 1);
        pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
        pos.setXYZ(i + 2, x, y, z);
      }
      pos.needsUpdate = true;
    }
  }
  geometry.deleteAttribute("normal");
  geometry.computeVertexNormals();
}
