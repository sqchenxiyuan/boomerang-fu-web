import * as THREE from 'three';

/*
 * Pixel-art presentation: the scene renders into a low-resolution target, then a
 * full-screen pass upscales it with nearest sampling, tone maps, posterises with
 * a 4×4 ordered dither and darkens silhouette edges found in the depth buffer.
 * Purely visual; it changes nothing in the simulation.
 */
/** Objects on this layer (name labels) are drawn crisp, above the pixel art. */
export const OVERLAY_LAYER = 1;

export interface PixelPassOptions {
  /** CSS pixels per art pixel; omitted, it targets about 300 art pixels of height. */
  pixelSize?: number;
  /** Colour levels per channel after tone mapping. */
  levels?: number;
  /** Relative depth jump that counts as an outline. */
  edge?: number;
}

export interface PixelPass {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float levels;
  uniform float edge;
  uniform float cameraNear;
  uniform float cameraFar;
  varying vec2 vUv;

  float viewDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x;
    // Perspective depth → linear view distance.
    return (cameraNear * cameraFar) / ((cameraFar - cameraNear) * z - cameraFar) * -1.0;
  }

  float bayer(vec2 p) {
    int x = int(mod(p.x, 4.0));
    int y = int(mod(p.y, 4.0));
    int i = x + y * 4;
    float m[16];
    m[0]=0.0; m[1]=8.0; m[2]=2.0; m[3]=10.0; m[4]=12.0; m[5]=4.0; m[6]=14.0; m[7]=6.0;
    m[8]=3.0; m[9]=11.0; m[10]=1.0; m[11]=9.0; m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
    for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.5;
    return 0.0;
  }

  void main() {
    vec2 texel = 1.0 / resolution;
    vec2 cell = (floor(vUv * resolution) + 0.5) * texel;
    vec3 color = texture2D(tColor, cell).rgb;
    float d = viewDepth(cell);
    float farthest = max(
      max(viewDepth(cell + vec2(texel.x, 0.0)), viewDepth(cell - vec2(texel.x, 0.0))),
      max(viewDepth(cell + vec2(0.0, texel.y)), viewDepth(cell - vec2(0.0, texel.y)))
    );
    // Only the nearer side of a depth jump gets the line: crisp 1-pixel silhouettes.
    float outline = step(edge * d, farthest - d);
    color *= mix(1.0, 0.42, outline);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    vec3 graded = gl_FragColor.rgb * levels + bayer(floor(vUv * resolution)) * 0.38;
    gl_FragColor.rgb = clamp(floor(graded + 0.5) / levels, 0.0, 1.0);
  }
`;

export function createPixelPass(
  renderer: THREE.WebGLRenderer,
  options: PixelPassOptions = {},
): PixelPass {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  target.depthTexture = new THREE.DepthTexture(1, 1);
  target.depthTexture.type = THREE.UnsignedIntType;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: target.texture },
      tDepth: { value: target.depthTexture },
      resolution: { value: new THREE.Vector2(1, 1) },
      levels: { value: options.levels ?? 15 },
      edge: { value: options.edge ?? 0.035 },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 100 },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  material.toneMapped = true;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const screen = new THREE.Scene();
  screen.add(quad);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2();

  return {
    render(scene, camera) {
      renderer.getSize(size);
      const pixelSize = Math.max(
        1,
        Math.round(options.pixelSize ?? Math.min(5, Math.max(2, size.y / 300))),
      );
      const width = Math.max(1, Math.floor(size.x / pixelSize)),
        height = Math.max(1, Math.floor(size.y / pixelSize));
      if (target.width !== width || target.height !== height) {
        target.setSize(width, height);
        material.uniforms.resolution.value.set(width, height);
      }
      if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
        material.uniforms.cameraNear.value = camera.near;
        material.uniforms.cameraFar.value = camera.far;
      }
      const previous = renderer.getRenderTarget(),
        layers = camera.layers.mask,
        autoClear = renderer.autoClear;
      camera.layers.disable(OVERLAY_LAYER);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      renderer.render(screen, ortho);
      // Labels stay legible: draw only the overlay layer at full resolution.
      // A colour background always force-clears, so lift it for the overlay.
      const background = scene.background;
      scene.background = null;
      camera.layers.set(OVERLAY_LAYER);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
      camera.layers.mask = layers;
      scene.background = background;
    },
    dispose() {
      target.depthTexture?.dispose();
      target.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}
