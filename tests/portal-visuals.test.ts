import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Arena } from '../src/core/types';
import { createArena } from '../src/core/arena';
import { rectanglePath } from '../src/rendering/polygon-geometry';
import {
  createOriginalArenaView,
  flashOriginalGate,
  updateOriginalArena,
} from '../src/rendering/original-arena';
import { createArenaView } from '../src/rendering/arena-view';
import { portalTone, type PortalFx } from '../src/rendering/portal-visuals';
import { setSurfacePixel } from '../src/rendering/surfaces';
import { voxelEligible } from '../src/rendering/voxelize';

const arena = (): Arena => ({
  id: 'original-portal-fixture',
  sourceScene: 'LevelTeleportals',
  halfWidth: 10,
  halfHeight: 8,
  obstacles: [],
  pits: [],
  spawns: [],
  pickupSpawns: [],
  portals: [
    {
      id: 'a',
      exitId: 'b',
      position: { x: 2, y: 1 },
      angle: 0,
      direction: { x: 0, y: -1 },
      radius: 0.76,
      half: { x: 0.76, y: 0.14 },
      height: 1.85,
      color: '#b29bff',
    },
  ],
  floors: [
    {
      id: 'ground',
      position: { x: 0, y: 0 },
      paths: rectanglePath(9, 7),
      kind: 'ground',
      active: true,
    },
  ],
});

const fxOf = (group: THREE.Object3D) => group.userData.portalFx as PortalFx;

describe('portal light effects', () => {
  it('gives a gate a membrane, halo, floor pool and motes on its open side', () => {
    const view = createOriginalArenaView(arena());
    const gate = view.portals.get('a')!;
    const fx = fxOf(gate);
    expect(fx.membrane!.parent).toBe(gate);
    expect(fx.halo!.parent).toBe(gate);
    expect(fx.pool.parent).toBe(gate);
    expect(fx.motes).toBeInstanceOf(THREE.Points);
    // Shader-placed motes would be culled by their zero position buffer.
    expect(fx.motes.frustumCulled).toBe(false);
    // Gates are entered from local -z; their back stands against a wall.
    for (const part of [fx.membrane!, fx.halo!, fx.pool, fx.motes])
      expect(part.position.z).toBeLessThan(0);
    expect(fx.membrane!.geometry.parameters.height).toBeGreaterThan(1.5);
    expect(fx.membrane!.geometry.parameters.width).toBeCloseTo(1.52);
    // The pool lies on the floor and reaches out in front of the doorway.
    fx.pool.geometry.computeBoundingBox();
    const box = fx.pool.geometry.boundingBox!;
    expect(fx.pool.position.y).toBeGreaterThan(0);
    expect(fx.pool.position.y).toBeLessThan(0.05);
    expect(-box.min.z).toBeGreaterThan(box.max.z * 3);
  });

  it('keeps the light out of the voxel converter but voxelises the glowing caps', () => {
    const view = createOriginalArenaView(arena());
    const gate = view.portals.get('a')!;
    const fx = fxOf(gate);
    for (const part of [fx.membrane!, fx.halo!, fx.pool]) expect(voxelEligible(part)).toBe(false);
    const caps = gate.children.filter(
      (child) =>
        child instanceof THREE.Mesh &&
        (child.material as THREE.MeshStandardMaterial).emissive?.getHex() > 0,
    ) as THREE.Mesh[];
    // Two post caps and the keystone, in the portal's colour.
    expect(caps).toHaveLength(3);
    for (const cap of caps) {
      expect(voxelEligible(cap)).toBe(true);
      const material = cap.material as THREE.MeshStandardMaterial;
      expect(material.color.getHex()).toBe(portalTone('#b29bff').getHex());
      expect(material.userData.shared).toBe(true);
    }
  });

  it('follows the visual style through the shared surface uniform', () => {
    const view = createOriginalArenaView(arena());
    const fx = fxOf(view.portals.get('a')!);
    const materials = [fx.membrane!, fx.halo!, fx.pool, fx.motes].map((part) => part.material);
    try {
      setSurfacePixel(0.1);
      for (const material of materials) expect(material.uniforms.uSurfPixel.value).toBe(0.1);
    } finally {
      setSurfacePixel(0);
    }
    for (const material of materials) expect(material.uniforms.uSurfPixel.value).toBe(0);
    for (const material of materials) {
      expect(material.toneMapped).toBe(false);
      expect(material.depthWrite).toBe(false);
      expect(material.fragmentShader).toContain('#include <colorspace_fragment>');
    }
    // Pixel branches: per-cell colour tiers and square motes.
    expect(fx.membrane!.material.fragmentShader).toContain('pBayer4(cell)');
    expect(fx.motes.material.fragmentShader).toContain('gl_PointCoord');
  });

  it('flashes every part of the gate a teleport passes through, from simulation time', () => {
    const state = arena();
    const view = createOriginalArenaView(state);
    const fx = fxOf(view.portals.get('a')!);
    flashOriginalGate(view, { x: 2.3, y: 1.2 }, 5);
    updateOriginalArena(view, state, 5.1);
    expect(fx.flash.value).toBeCloseTo(0.8);
    for (const part of [fx.membrane!, fx.halo!, fx.pool, fx.motes])
      expect(part.material.uniforms.uFlash).toBe(fx.flash);
    updateOriginalArena(view, state, 5.6);
    expect(fx.flash.value).toBe(0);
  });

  it('builds the effects for every gate of every original map', async () => {
    const data = (await import('../src/core/original-map-data.json')).default as {
      arena: Arena;
    }[];
    let gates = 0;
    for (const { arena: level } of data) {
      if (!level.portals?.length) continue;
      const view = createOriginalArenaView(level);
      for (const portal of level.portals) {
        const fx = fxOf(view.portals.get(portal.id)!);
        const membrane = fx.membrane!;
        // Sunken gates (base below the floor) only show the part above it.
        const bottom = membrane.position.y - membrane.geometry.parameters.height / 2;
        expect(bottom + (portal.baseHeight ?? 0)).toBeGreaterThan(-0.01);
        expect(membrane.geometry.parameters.height).toBeGreaterThan(1.4);
        expect(fx.pool.position.y + (portal.baseHeight ?? 0)).toBeCloseTo(0.025, 2);
        gates++;
      }
    }
    expect(gates).toBe(44);
  });

  it('lights the round pads of the built-in portal garden too', () => {
    const level = createArena('portals');
    const view = createArenaView(level);
    expect(level.portals!.length).toBeGreaterThan(0);
    for (const portal of level.portals!) {
      const group = view.portals.get(portal.id)!;
      const fx = fxOf(group);
      expect(fx.pool.parent).toBe(group);
      expect(fx.motes.parent).toBe(group);
      expect(fx.pool.material.uniforms.uInner.value).toBeGreaterThan(0);
      // The renderer spins the first child, which must stay the ring.
      expect((group.children[0] as THREE.Mesh).geometry).toBeInstanceOf(THREE.RingGeometry);
    }
    const first = level.portals![0];
    flashOriginalGate(view, first.position, 2);
    expect(view.portals.get(first.id)!.userData.flashUntil).toBe(2.5);
  });

  it('turns the pastel map colours into richer light of the same hue', () => {
    for (const color of ['#49dbd4', '#b29bff', '#ee7bb3', '#f3aa56']) {
      const from = { h: 0, s: 0, l: 0 },
        to = { h: 0, s: 0, l: 0 };
      new THREE.Color(color).getHSL(from, THREE.SRGBColorSpace);
      portalTone(color).getHSL(to, THREE.SRGBColorSpace);
      expect(Math.abs(to.h - from.h)).toBeLessThan(0.01);
      expect(to.s).toBeGreaterThanOrEqual(from.s);
      expect(to.l).toBeGreaterThanOrEqual(0.45 - 1e-3);
      expect(to.l).toBeLessThanOrEqual(0.62 + 1e-3);
    }
  });
});
