import * as THREE from 'three';

const cache = new Map<string, THREE.MeshStandardMaterial>();
export function material(color: string, roughness = 0.88): THREE.MeshStandardMaterial {
  const key = `${color}:${roughness}`;
  if (!cache.has(key)) {
    const shared = new THREE.MeshStandardMaterial({ color, roughness, flatShading: true });
    shared.userData.shared = true;
    cache.set(key, shared);
  }
  return cache.get(key)!;
}
export function mesh(geometry: THREE.BufferGeometry, color: string): THREE.Mesh {
  const object = new THREE.Mesh(geometry, material(color));
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}
export function box(w: number, h: number, d: number, color: string): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), color);
}
export function sphere(r: number, color: string, detail = 1): THREE.Mesh {
  return mesh(new THREE.IcosahedronGeometry(r, detail), color);
}
export function cylinder(
  top: number,
  bottom: number,
  height: number,
  color: string,
  sides = 10,
): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(top, bottom, height, sides), color);
}
export function place<T extends THREE.Object3D>(
  object: T,
  x: number,
  y: number,
  z: number,
  parent: THREE.Object3D,
): T {
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

export function makeBoomerang(color = '#f7d58c'): THREE.Group {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.58, -0.22);
  shape.lineTo(-0.43, -0.4);
  shape.lineTo(0.05, -0.04);
  shape.lineTo(0.59, -0.25);
  shape.lineTo(0.68, 0.02);
  shape.lineTo(0.02, 0.36);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.11,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.035,
    bevelThickness: 0.025,
  });
  geometry.rotateX(Math.PI / 2);
  const body = mesh(geometry, color);
  group.add(body);
  const middle = box(0.13, 0.025, 0.28, '#fff5d6');
  middle.position.set(0, 0.06, 0.04);
  middle.rotation.y = -0.3;
  group.add(middle);
  return group;
}

export function shadow(radius: number, opacity = 0.16): THREE.Mesh {
  const object = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({
      color: '#173e35',
      transparent: true,
      opacity,
      depthWrite: false,
    }),
  );
  object.rotation.x = -Math.PI / 2;
  object.position.y = 0.025;
  return object;
}
