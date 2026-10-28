import * as THREE from 'three';
import type { Vec2 } from '../core/math';
import { inPaths } from '../core/geometry';

const area = (path: Vec2[]): number =>
  path.reduce((sum, p, i) => {
    const q = path[(i + 1) % path.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0) / 2;

/** Keep the core's even-odd fill rule: disjoint islands, holes and islands in
 * holes are all supported. Shape-space Y is negated before the XZ rotation. */
export function contourShapes(paths: Vec2[][]): THREE.Shape[] {
  const loops = paths
    .map((path) =>
      path.filter((p, i) => {
        const previous = path[(i + path.length - 1) % path.length];
        return (
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          (Math.abs(p.x - previous.x) > 1e-7 || Math.abs(p.y - previous.y) > 1e-7)
        );
      }),
    )
    .filter((path) => path.length >= 3 && Math.abs(area(path)) > 1e-8)
    .map((path) => ({ path, area: Math.abs(area(path)), parent: -1, depth: 0 }));
  for (let i = 0; i < loops.length; i++) {
    let parentArea = Infinity;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || loops[j].area <= loops[i].area || loops[j].area >= parentArea) continue;
      if (inPaths(loops[i].path[0], [loops[j].path])) {
        loops[i].parent = j;
        parentArea = loops[j].area;
      }
    }
  }
  for (const loop of loops) {
    let parent = loop.parent;
    while (parent !== -1) {
      loop.depth++;
      parent = loops[parent].parent;
    }
  }
  const draw = <T extends THREE.Path>(target: T, path: Vec2[]): T => {
    target.moveTo(path[0].x, -path[0].y);
    for (const p of path.slice(1)) target.lineTo(p.x, -p.y);
    target.closePath();
    return target;
  };
  return loops.flatMap((loop, index) => {
    if (loop.depth % 2) return [];
    const shape = draw(new THREE.Shape(), loop.path);
    for (const child of loops) {
      if (child.parent === index && child.depth % 2)
        shape.holes.push(draw(new THREE.Path(), child.path));
    }
    return [shape];
  });
}

/** Local (x,y) contours become Three (x,height,z=y), with the bottom at zero. */
export function extrudeContours(paths: Vec2[][], height: number): THREE.BufferGeometry {
  const shapes = contourShapes(paths);
  if (!shapes.length) return new THREE.BufferGeometry();
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: Math.max(0.001, height),
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function rectanglePath(x: number, y: number): Vec2[][] {
  return [
    [
      { x: -x, y: -y },
      { x, y: -y },
      { x, y },
      { x: -x, y },
    ],
  ];
}
