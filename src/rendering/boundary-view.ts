import * as THREE from 'three';
import type { GameState } from '../core/types';
import { boundaryWarning } from '../core/feedback';
import { RULES } from '../core/config';

const vertex = `varying vec2 uvLocal; void main(){uvLocal=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;

function arrow(color: string): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.65);
  shape.lineTo(-0.32, 0.15);
  shape.lineTo(-0.12, 0.15);
  shape.lineTo(-0.12, -0.35);
  shape.lineTo(0.12, -0.35);
  shape.lineTo(0.12, 0.15);
  shape.lineTo(0.32, 0.15);
  shape.closePath();
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** Original boundary semantics, rebuilt with procedural Web geometry and shaders. */
export class BoundaryView {
  readonly root = new THREE.Group();
  private line: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private glow = new THREE.Group();
  private marker = new THREE.Group();
  private walls: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[] = [];
  private arrows: THREE.Mesh[] = [];
  private warnings = new Map<
    number,
    {
      root: THREE.Group;
      arrow: THREE.Mesh;
      label: THREE.Sprite;
      canvas: HTMLCanvasElement;
      text: string;
    }
  >();

  constructor() {
    this.line = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          extent: { value: new THREE.Vector2(13.3, 8.5) },
          halfSize: { value: new THREE.Vector2(13, 8.2) },
          time: { value: 0 },
          scroll: { value: -0.5 },
          opacity: { value: 0.1 },
          flash: { value: 0 },
        },
        vertexShader: vertex,
        fragmentShader: `varying vec2 uvLocal;uniform vec2 extent;uniform vec2 halfSize;uniform float time,scroll,opacity,flash;
      void main(){ vec2 p=(uvLocal*2.0-1.0)*extent; vec2 h=halfSize-vec2(0.132); vec2 edge=abs(p)-h;
        float d=abs(max(edge.x,edge.y)); float aa=max(fwidth(d),0.008); float band=1.0-smoothstep(0.04-aa,0.04+aa,d);
        float path=edge.x>edge.y ? (p.x>0.0 ? p.y+h.y : 4.0*h.y+2.0*h.x-p.y-h.y) : (p.y>0.0 ? 2.0*h.y+h.x-p.x : 4.0*h.y+3.0*h.x+p.x);
        float dash=1.0-smoothstep(0.36,0.4,mod(path+time*scroll,0.7));
        gl_FragColor=vec4(mix(vec3(0.045),vec3(1.0),flash),band*dash*opacity); }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.line.rotation.x = -Math.PI / 2;
    this.line.position.y = 0.07;
    this.line.renderOrder = 2;
    const glowMaterial = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: `varying vec2 uvLocal;void main(){float a=pow(1.0-uvLocal.y,2.5)*0.32;gl_FragColor=vec4(1.0,0.16,0.1,a);}`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 4; i++) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial.clone());
      wall.renderOrder = 3;
      this.glow.add(wall);
      this.walls.push(wall);
      const item = arrow('#fff2bc');
      this.marker.add(item);
      this.arrows.push(item);
    }
    glowMaterial.dispose();
    this.root.add(this.line, this.glow, this.marker);
    this.root.name = 'game-boundary';
  }

  update(state: GameState, menu: boolean): void {
    this.root.visible = !menu && state.phase !== 'countdown' && !state.boundary.allowOutside;
    if (!this.root.visible) return;
    const bounds = state.boundary;
    const angle = bounds.angle ?? 0;
    const { x: hx, y: hy } = bounds.halfSize;
    this.line.position.set(bounds.center.x, 0.07, bounds.center.y);
    this.line.rotation.set(-Math.PI / 2, -angle, 0, 'YXZ');
    this.line.scale.set(hx + 0.3, hy + 0.3, 1);
    this.line.material.uniforms.extent.value.set(hx + 0.3, hy + 0.3);
    this.line.material.uniforms.halfSize.value.set(hx, hy);
    this.line.material.uniforms.time.value = state.time;
    this.line.material.uniforms.scroll.value = bounds.phase === 'shrinking' ? 0.25 : -0.5;
    const outside = state.actors.some((a) => a.alive && a.outOfBounds);
    const cos = Math.cos(angle),
      sin = Math.sin(angle);
    const near = state.actors.some((actor) => {
      if (!actor.alive) return false;
      const dx = actor.position.x - bounds.center.x,
        dy = actor.position.y - bounds.center.y;
      return (
        Math.min(hx - Math.abs(dx * cos + dy * sin), hy - Math.abs(-dx * sin + dy * cos)) < 1.2
      );
    });
    this.line.material.uniforms.opacity.value =
      bounds.phase === 'shrinking' || outside ? 0.8 : near ? 0.298 : 0.102;
    this.line.material.uniforms.flash.value =
      bounds.phase !== 'idle' ? Math.max(0, 1 - (state.time - bounds.startedAt) / 0.5) : 0;
    this.glow.visible = bounds.phase !== 'idle';
    this.glow.position.set(bounds.center.x, 0, bounds.center.y);
    this.glow.rotation.y = -angle;
    for (let i = 0; i < 4; i++) {
      const horizontal = i < 2,
        sign = i % 2 ? -1 : 1;
      const wall = this.walls[i];
      wall.position.set(horizontal ? 0 : sign * hx, 2.02, horizontal ? sign * hy : 0);
      wall.rotation.y = horizontal ? 0 : Math.PI / 2;
      wall.scale.set((horizontal ? hx : hy) * 2, 4, 1);
    }
    this.marker.visible = bounds.phase === 'shrinking' && state.phase === 'playing';
    this.marker.position.set(bounds.targetCenter.x, 0.12, bounds.targetCenter.y);
    this.marker.rotation.y = -angle;
    const beat = ((state.time - bounds.startedAt) * 0.85) % 1;
    this.arrows.forEach((item, i) => {
      const angle = (i * Math.PI) / 2;
      const radius = 1.1 + (1 - beat) * 1.25;
      item.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      item.rotation.z = angle;
      (item.material as THREE.MeshBasicMaterial).opacity = Math.sin(beat * Math.PI) * 0.85;
    });
    const liveIds = new Set(state.actors.map((a) => a.id));
    for (const actor of state.actors) {
      let view = this.warnings.get(actor.id);
      const warning = boundaryWarning(actor);
      if (!view && warning.visible) {
        const root = new THREE.Group(),
          canvas = document.createElement('canvas');
        canvas.width = 192;
        canvas.height = 72;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const label = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }),
        );
        label.position.y = 3.1;
        label.scale.set(1.8, 0.675, 1);
        label.renderOrder = 12;
        const pointer = arrow('#ee594e');
        pointer.position.y = 0.1;
        root.add(label, pointer);
        this.root.add(root);
        view = { root, arrow: pointer, label, canvas, text: '' };
        this.warnings.set(actor.id, view);
      }
      if (!view) continue;
      view.root.visible = warning.visible;
      if (!warning.visible) continue;
      view.root.position.set(actor.position.x, 0, actor.position.y);
      const dx = bounds.center.x - actor.position.x,
        dy = bounds.center.y - actor.position.y;
      const angle = Math.atan2(dx, dy);
      view.arrow.rotation.z = angle + Math.PI;
      view.arrow.position.set(
        Math.sin(angle) * (RULES.playerRadius + 0.55),
        0.1,
        Math.cos(angle) * (RULES.playerRadius + 0.55),
      );
      (view.arrow.material as THREE.Material).opacity = 0.3 + warning.pulse * 0.7;
      const label = `返回 ${warning.seconds.toFixed(1)}s`;
      if (view.text !== label) {
        view.text = label;
        const ctx = view.canvas.getContext('2d')!;
        ctx.clearRect(0, 0, 192, 72);
        ctx.fillStyle = '#b54439';
        ctx.beginPath();
        ctx.roundRect(2, 6, 188, 60, 20);
        ctx.fill();
        ctx.font = 'bold 25px system-ui, Microsoft YaHei';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff5dc';
        ctx.fillText(label, 96, 37);
        view.label.material.map!.needsUpdate = true;
      }
    }
    for (const [id, view] of this.warnings)
      if (!liveIds.has(id)) {
        this.disposeWarning(view);
        this.warnings.delete(id);
      }
  }

  private disposeWarning(view: {
    root: THREE.Group;
    arrow: THREE.Mesh;
    label: THREE.Sprite;
  }): void {
    view.root.removeFromParent();
    view.arrow.geometry.dispose();
    (view.arrow.material as THREE.Material).dispose();
    view.label.material.map?.dispose();
    view.label.material.dispose();
  }

  reset(): void {
    for (const view of this.warnings.values()) this.disposeWarning(view);
    this.warnings.clear();
  }
  dispose(): void {
    this.reset();
    this.root.removeFromParent();
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
  }
}
