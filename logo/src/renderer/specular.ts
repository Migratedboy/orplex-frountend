/**
 * Vanilla WebGL2 port of the "specular rim light" shader effect (originally a
 * React + OGL component). No dependencies: raw WebGL2, one triangle, one SDF.
 *
 * The SDF is a rounded rectangle; with radius = half the short side it renders
 * both the widget's circle (64x64, r=32) and its cylinder capsule (64x150,
 * r=32) — so a single effect covers both states.
 */

// Module-load marker for boot diagnostics.
if (typeof document !== 'undefined' && document.body !== null) {
  document.body.dataset.spec = 'module-ok';
}

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform vec2 uHalfSize;
uniform float uRadius;
uniform float uAngle;
uniform float uPx;
uniform vec3 uLineColor;
uniform vec3 uBaseColor;
uniform float uIntensity;
uniform float uShineSize;
uniform float uShineFade;
uniform float uThickness;
uniform float uBaseWidth;

out vec4 fragColor;

float sdRoundedRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float shapeSDF(vec2 p) { return sdRoundedRect(p, uHalfSize, uRadius); }

float gaussianLine(float d, float sigma) {
  float x = d / (sigma + 1e-6);
  float k = mix(1.0, 1.6, smoothstep(0.0, 1.5, x));
  return exp(-k * x * x);
}

void main() {
  vec2 p = gl_FragCoord.xy - uCenter;
  float d = shapeSDF(p);
  vec2 L = vec2(cos(uAngle), sin(uAngle));

  // Dark base stroke hugging the edge for a sense of thickness
  float base = (1.0 - smoothstep(0.0, uBaseWidth, abs(d))) * 0.45;

  // Symmetric specular: edges facing toward/away from the light catch a streak.
  vec2 nEll = normalize(p / (uHalfSize * uHalfSize) + 1e-6);
  float phi = acos(clamp(abs(dot(nEll, L)), 0.0, 1.0));
  float rim = 1.0 - smoothstep(uShineSize - uShineFade, uShineSize + uShineFade + 1e-4, phi);
  float line = gaussianLine(d, uThickness);
  float edgeClamp = 1.0 - smoothstep(0.5 * uPx, 3.0 * uPx, abs(d));
  float hi = line * rim * edgeClamp * uIntensity;

  vec3 col = uBaseColor * base + uLineColor * hi;
  float a = clamp(base + hi, 0.0, 1.0);
  fragColor = vec4(col, a);
}
`;

export interface SpecularOptions {
  /** Shape short-side radius in CSS px (32 for both circle and capsule). */
  radius: number;
  lineColor?: string;
  baseColor?: string;
  intensity?: number;
  shineSize?: number;
  shineFade?: number;
  thickness?: number;
  speed?: number;
  followMouse?: boolean;
}

interface Uniforms {
  uCenter: WebGLUniformLocation | null;
  uHalfSize: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uAngle: WebGLUniformLocation | null;
  uPx: WebGLUniformLocation | null;
  uLineColor: WebGLUniformLocation | null;
  uBaseColor: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
  uShineSize: WebGLUniformLocation | null;
  uShineFade: WebGLUniformLocation | null;
  uThickness: WebGLUniformLocation | null;
  uBaseWidth: WebGLUniformLocation | null;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[specular] shader error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Renders the specular rim into `host` (a positioned container that extends
 * PAD px beyond the shape on every side). Tracks the pointer window-wide and
 * steers the light toward it, with an idle sweep when the mouse is still.
 */
export function attachSpecularGlow(
  host: HTMLElement,
  options: SpecularOptions
): { dispose(): void; setShape(w: number, h: number): void } {
  const canvas = document.createElement('canvas');
  canvas.className = 'specular-canvas';
  host.appendChild(canvas);

  const ctx = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
  });
  if (ctx === null) {
    console.warn('[specular] WebGL2 unavailable; glow disabled');
    canvas.remove();
    return { dispose: () => undefined, setShape: () => undefined };
  }
  // Non-null alias keeps narrowing inside the closures below.
  const gl: WebGL2RenderingContext = ctx;

  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (vs === null || fs === null) {
    console.warn('[specular] shader compile failed; glow disabled');
    canvas.remove();
    return { dispose: () => undefined, setShape: () => undefined };
  }
  const program = gl.createProgram();
  if (program === null) {
    canvas.remove();
    return { dispose: () => undefined, setShape: () => undefined };
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[specular] link error:', gl.getProgramInfoLog(program));
    canvas.remove();
    return { dispose: () => undefined, setShape: () => undefined };
  }
  gl.useProgram(program);

  // Fullscreen triangle.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  const loc = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(program, name);
  const uniforms: Uniforms = {
    uCenter: u('uCenter'),
    uHalfSize: u('uHalfSize'),
    uRadius: u('uRadius'),
    uAngle: u('uAngle'),
    uPx: u('uPx'),
    uLineColor: u('uLineColor'),
    uBaseColor: u('uBaseColor'),
    uIntensity: u('uIntensity'),
    uShineSize: u('uShineSize'),
    uShineFade: u('uShineFade'),
    uThickness: u('uThickness'),
    uBaseWidth: u('uBaseWidth'),
  };

  const dpr = window.devicePixelRatio || 1;
  gl.uniform1f(uniforms.uPx, dpr);

  const parse = (hex: string): [number, number, number] => {
    const v = hex.replace('#', '');
    const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
    const n = Number.parseInt(full, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };
  const lineC = parse(options.lineColor ?? '#ffffff');
  const baseC = parse(options.baseColor ?? '#525252');
  gl.uniform3fv(uniforms.uLineColor, lineC);
  gl.uniform3fv(uniforms.uBaseColor, baseC);

  gl.uniform1f(uniforms.uShineSize, ((options.shineSize ?? 10) * Math.PI) / 180);
  gl.uniform1f(uniforms.uShineFade, ((options.shineFade ?? 40) * Math.PI) / 180);
  gl.uniform1f(uniforms.uThickness, (options.thickness ?? 1) * dpr);
  gl.uniform1f(uniforms.uBaseWidth, dpr);
  gl.uniform1f(uniforms.uRadius, options.radius * dpr);

  // Shape state: CSS size of the icon (not the padded host).
  let shapeW = 64;
  let shapeH = 64;

  function resize(): void {
    const w = shapeW + 40; // PAD*2 bleed
    const h = shapeH + 40;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.uCenter, (20 + shapeW / 2) * dpr, (20 + shapeH / 2) * dpr);
    gl.uniform2f(uniforms.uHalfSize, (shapeW / 2) * dpr, (shapeH / 2) * dpr);
  }

  function setShape(w: number, h: number): void {
    if (w === shapeW && h === shapeH) return;
    shapeW = w;
    shapeH = h;
    resize();
  }
  resize();

  // Light steering: pointer anywhere (client coords work even when the
  // pointer is far outside this small window); idle sweep when untouched.
  let pointerAngle: number | null = null;
  const onPointerMove = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    pointerAngle = Math.atan2(cy - e.clientY, e.clientX - cx);
  };
  window.addEventListener('pointermove', onPointerMove);

  const speed = options.speed ?? 0.35;
  const followMouse = options.followMouse ?? true;
  let angle = 2.4;
  let idleAngle = 2.4;
  let bright = 0;
  let last = performance.now();
  let raf = 0;

  function frame(now: number): void {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    idleAngle += speed * dt;
    const target =
      pointerAngle !== null && followMouse ? pointerAngle : idleAngle;
    const diff = ((target - angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    angle += diff * (1 - Math.exp(-dt * 7));
    bright += (1 - bright) * (1 - Math.exp(-dt * 8));

    gl.uniform1f(uniforms.uAngle, angle);
    gl.uniform1f(uniforms.uIntensity, (options.intensity ?? 1) * bright);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  raf = requestAnimationFrame(frame);

  return {
    dispose(): void {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointerMove);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    },
    setShape,
  };
}
