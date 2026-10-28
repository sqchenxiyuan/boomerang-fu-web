import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A renderer owns its buffers and material. Resetting the count never allocates
 * or releases GPU objects; final disposal is deliberately a separate operation. */
export class InstanceBatch {
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private alpha: THREE.InstancedBufferAttribute;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private rotation = new THREE.Euler();
  private quaternion = new THREE.Quaternion();
  private colors = new Map<string | number, THREE.Color>();
  private used = 0;
  private disposed = false;
  dropped = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    readonly capacity: number,
  ) {
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('instanceAlpha', this.alpha);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
      vertexShader: `attribute float instanceAlpha;
        varying vec4 effectColor;
        void main(){
          vec3 worldNormal=normalize(mat3(instanceMatrix)*normal);
          float light=0.72+0.3*max(0.0,dot(worldNormal,normalize(vec3(-0.3,0.8,0.5))));
          effectColor=vec4(instanceColor*light,instanceAlpha);
          gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.0);
        }`,
      fragmentShader: `varying vec4 effectColor;
        void main(){
          gl_FragColor=effectColor;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    material.forceSinglePass = true;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  begin(): void {
    this.used = 0;
    this.dropped = 0;
  }

  add(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: string | number,
    opacity = 1,
    rx = 0,
    ry = 0,
    rz = 0,
  ): boolean {
    if (this.disposed || this.used >= this.capacity) {
      this.dropped++;
      return false;
    }
    this.position.set(x, y, z);
    this.scale.set(sx, sy, sz);
    this.quaternion.setFromEuler(this.rotation.set(rx, ry, rz));
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(this.used, this.matrix);
    let parsed = this.colors.get(color);
    if (!parsed) {
      parsed = new THREE.Color(color);
      this.colors.set(color, parsed);
    }
    this.mesh.setColorAt(this.used, parsed);
    this.alpha.setX(this.used, Math.max(0, Math.min(1, opacity)));
    this.used++;
    return true;
  }

  end(): void {
    this.mesh.count = this.used;
    this.mesh.visible = this.used > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  clear(): void {
    this.begin();
    this.end();
  }
  get count(): number {
    return this.used;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.colors.clear();
  }
}

/** Merge only explicitly static subtrees. Each excluded object remains reachable
 * under the same parent, so flag/portal animation and broken obstacles still work. */
export function mergeStaticMeshes(
  root: THREE.Object3D,
  excluded = new Set<THREE.Object3D>(),
): number {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const references = new Map<THREE.BufferGeometry, number>();
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) references.set(o.geometry, (references.get(o.geometry) ?? 0) + 1);
  });
  const groups = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]>();
  const visit = (object: THREE.Object3D): void => {
    if (excluded.has(object)) return;
    if (
      object instanceof THREE.Mesh &&
      object !== root &&
      object.children.length === 0 &&
      !Array.isArray(object.material) &&
      !object.material.transparent &&
      !(object instanceof THREE.SkinnedMesh)
    ) {
      const key = `${object.material.uuid}:${object.castShadow}:${object.receiveShadow}:${Object.keys(object.geometry.attributes).sort().join(',')}`;
      const group = groups.get(key) ?? [];
      group.push(object);
      groups.set(key, group);
    }
    for (const child of object.children) visit(child);
  };
  visit(root);
  let removed = 0;
  for (const objects of groups.values()) {
    if (objects.length < 2) continue;
    const copies = objects.map((o) => {
      const geometry = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      return geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld));
    });
    const merged = mergeGeometries(copies, false);
    for (const copy of copies) copy.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, objects[0].material);
    mesh.name = `static-batch-${objects.length}`;
    mesh.castShadow = objects[0].castShadow;
    mesh.receiveShadow = objects[0].receiveShadow;
    root.add(mesh);
    for (const source of objects) {
      source.removeFromParent();
      const remaining = (references.get(source.geometry) ?? 1) - 1;
      references.set(source.geometry, remaining);
      if (remaining === 0) source.geometry.dispose();
      removed++;
    }
  }
  return removed;
}
