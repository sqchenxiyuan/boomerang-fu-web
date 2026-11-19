import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Arena } from '../src/core/types';
import { rectanglePath } from '../src/rendering/polygon-geometry';
import { createOriginalArenaView, updateOriginalArena } from '../src/rendering/original-arena';
import { IceMaterial, pixelOverlayGeometry, WaterMaterial } from '../src/rendering/surfaces';
import { portalTone, type SwitchFx } from '../src/rendering/portal-visuals';
import { actorColor } from '../src/agents/registry';

const arena = (): Arena => ({
  id: 'original-hazard-fixture',
  sourceScene: 'LevelSquare',
  halfWidth: 10,
  halfHeight: 8,
  obstacles: [],
  pits: [],
  spawns: [],
  pickupSpawns: [],
  portals: [],
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

describe('ice overlays', () => {
  const iceArena = (): Arena => ({
    ...arena(),
    surfaces: [
      {
        id: 'rink',
        kind: 'ice',
        position: { x: 1.03, y: -0.97 },
        angle: 0.5,
        paths: rectanglePath(2, 1.5),
      },
    ],
  });

  it('use the ice material, with a rim attribute the smooth geometry leaves at zero', () => {
    const view = createOriginalArenaView(iceArena());
    const ice = view.root.getObjectByName('surface:rink') as THREE.Mesh;
    expect(ice.material).toBeInstanceOf(IceMaterial);
    expect(ice.userData.pixelOverlay).toBe(true);
    const edge = ice.geometry.getAttribute('aIceEdge');
    expect(edge.count).toBe(ice.geometry.getAttribute('position').count);
    expect(Array.from(edge.array as Float32Array).every((value) => value === 0)).toBe(true);
    const material = ice.material as IceMaterial;
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader);
    expect(shader.vertexShader).toContain('vIceEdge = aIceEdge');
    expect(shader.fragmentShader).toContain('sCells(c / 1.3)');
    expect(shader.fragmentShader).toContain('#include <lights_fragment_begin>');
  });

  it('become whole world-grid cells in the pixel style, rim cells marked', () => {
    const view = createOriginalArenaView(iceArena());
    const ice = view.root.getObjectByName('surface:rink') as THREE.Mesh;
    const cell = 0.1;
    const geometry = pixelOverlayGeometry(ice, cell)!;
    expect(geometry).not.toBeNull();
    // Back in world space every corner sits on the voxel grid.
    const world = geometry.clone().applyMatrix4(ice.matrixWorld);
    const position = world.getAttribute('position');
    let area = 0;
    for (let i = 0; i < position.count; i++) {
      for (const value of [position.getX(i), position.getZ(i)])
        expect(Math.abs(value / cell - Math.round(value / cell))).toBeLessThan(1e-4);
      expect(position.getY(i)).toBeCloseTo(0.018, 5);
    }
    for (let i = 0; i < position.count; i += 3) {
      const ax = position.getX(i),
        az = position.getZ(i);
      area +=
        Math.abs(
          (position.getX(i + 1) - ax) * (position.getZ(i + 2) - az) -
            (position.getZ(i + 1) - az) * (position.getX(i + 2) - ax),
        ) / 2;
    }
    // A 4 × 3 rectangle, give or take the stepped border.
    expect(area).toBeGreaterThan(11);
    expect(area).toBeLessThan(13);
    const edges = Array.from(geometry.getAttribute('aIceEdge').array as Float32Array);
    expect(edges.some((value) => value === 1)).toBe(true);
    expect(edges.some((value) => value === 0)).toBe(true);
    // Faces point up, so the ice is not culled from above.
    world.computeVertexNormals();
    expect(world.getAttribute('normal').getY(0)).toBeCloseTo(1);
  });
});

describe('wall switches', () => {
  const switchArena = (): Arena => ({
    ...arena(),
    environment: {
      mechanisms: [
        { id: 'lever', kind: 'switch', position: { x: 2, y: 1 }, active: true },
        { id: 'spent', kind: 'switch', position: { x: -2, y: 1 }, active: false },
      ],
    },
  });
  const parts = (view: ReturnType<typeof createOriginalArenaView>, id: string) => {
    const group = view.mechanisms.get(id)!;
    return {
      knob: group.userData.knob as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
      fx: group.userData.switchFx as SwitchFx,
    };
  };

  it('glow while usable and go dark once spent', () => {
    const state = switchArena();
    const view = createOriginalArenaView(state);
    const lever = parts(view, 'lever'),
      spent = parts(view, 'spent');
    expect(lever.fx.pool.visible).toBe(true);
    expect(lever.knob.material.emissive.getHex()).toBe(new THREE.Color('#8fd3af').getHex());
    expect(lever.knob.material.emissiveIntensity).toBeGreaterThan(0.3);
    expect(spent.fx.pool.visible).toBe(false);
    expect(spent.knob.material.emissiveIntensity).toBeLessThan(0.1);
    // Each switch flashes on its own.
    expect(lever.knob.material).not.toBe(spent.knob.material);
  });

  it('flash in the colour of whoever hit them, easing back over 0.75 s', () => {
    const state = switchArena();
    const view = createOriginalArenaView(state);
    const lever = parts(view, 'lever');
    const mechanism = state.environment!.mechanisms[0];
    mechanism.flashTime = 0.75;
    mechanism.ownerId = 1;
    updateOriginalArena(view, state, 1);
    expect(lever.fx.flash.value).toBeCloseTo(1);
    expect(lever.knob.material.emissive.getHex()).toBe(new THREE.Color(actorColor(1)).getHex());
    const glow = lever.fx.pool.material.uniforms.uColor.value as THREE.Color;
    expect(glow.getHex()).toBe(portalTone(actorColor(1)).getHex());
    mechanism.flashTime = 0.375;
    updateOriginalArena(view, state, 1.375);
    expect(lever.fx.flash.value).toBeCloseTo(0.25);
    mechanism.flashTime = 0;
    updateOriginalArena(view, state, 2);
    expect(lever.fx.flash.value).toBe(0);
    expect(glow.getHex()).toBe(lever.fx.tone.getHex());
  });
});

describe('collapsing floors', () => {
  const collapseArena = (kind: 'trapFloor' | 'fallingFloor'): Arena => {
    const level = arena();
    level.floors!.push({
      id: 'tile',
      position: { x: 3, y: 0 },
      paths: rectanglePath(1, 1),
      kind: 'falling',
      active: true,
      mechanismId: 'hazard',
    });
    level.environment = {
      mechanisms: [{ id: 'hazard', kind, position: { x: 3, y: 0 }, phase: 'warning' }],
    };
    return level;
  };
  const tint = (kind: 'trapFloor' | 'fallingFloor', warning: number) => {
    const state = collapseArena(kind);
    const view = createOriginalArenaView(state);
    state.floors![1].warning = warning;
    // sin(time * 15) = 0, so the pulse is neutral.
    updateOriginalArena(view, state, 0);
    const group = view.floors.get('tile')!;
    const top = group.userData.topMaterial as THREE.MeshStandardMaterial;
    const base = group.userData.baseColor as THREE.Color;
    const red = new THREE.Color('#ff1a33');
    // How far the top has moved from its own colour towards red.
    return (top.color.r - base.r) / (red.r - base.r);
  };

  it('turn red, up to half strength, as the source FloorHazard flash does', () => {
    expect(tint('fallingFloor', 1)).toBeCloseTo(0.5, 2);
    expect(tint('fallingFloor', 0.5)).toBeCloseTo(0.25, 2);
    // Traps build up late.
    expect(tint('trapFloor', 0.5)).toBeCloseTo(0.0625, 2);
    expect(tint('trapFloor', 1)).toBeCloseTo(0.5, 2);
  });
});

describe('pixel water', () => {
  it('keeps glints sparse and out of the shallow band', () => {
    const water = new WaterMaterial({ color: '#65aab8' });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    water.onBeforeCompile(shader);
    expect(shader.fragmentShader).toContain('step(0.965,');
    expect(shader.fragmentShader).toContain('step(0.45, v)');
  });
});
