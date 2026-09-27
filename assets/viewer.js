/* AllocSplat supplementary viewer. Self-contained: no network access, works from file://.
 * Gaussians are drawn with a WebGL2 EWA splatting pass (back-to-front, premultiplied alpha),
 * anchors as depth-tested discs. Camera convention follows the exported data: OpenCV
 * (x right, y down, z forward), world-to-camera matrices, pixel intrinsics at 252x252. */
(function () {
  'use strict';

  const MAN = window.SUPP_MANIFEST;
  const TEX_W = 4096;
  const VIEW_RGB = [[0.894, 0.341, 0.180], [0.180, 0.525, 0.671], [0.341, 0.655, 0.451], [0.690, 0.482, 0.675],
                    [0.851, 0.635, 0.110], [0.451, 0.337, 0.271]];

  // ---------------------------------------------------------------- data loading
  const cache = {}, waiting = {};
  window.__suppLoad = function (key, b64) {
    const bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    cache[key] = u8.buffer;
    (waiting[key] || []).forEach(f => f());
    delete waiting[key];
  };
  function fetchBudget(key, b) {
    return new Promise((resolve, reject) => {
      if (cache[key]) return resolve(cache[key]);
      (waiting[key] = waiting[key] || []).push(() => resolve(cache[key]));
      if (!document.querySelector('script[data-key="' + key + '"]')) {
        const s = document.createElement('script');
        s.src = b.file; s.dataset.key = key;
        s.onerror = () => reject(new Error('Could not read ' + b.file + '. Keep the data folder next to index.html.'));
        document.head.appendChild(s);
      }
    });
  }
  function h2f(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * 6.103515625e-5 * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  function parse(buf, b) {
    const N = b.N, M = b.M; let o = 0;
    const axyz = new Float32Array(buf, o, 3 * M); o += 12 * M;
    const rho = new Float32Array(buf, o, M); o += 4 * M;
    const qp = new Uint16Array(buf, o, 3 * N); o += 6 * N;
    const pos = new Float32Array(3 * N);
    for (let i = 0; i < 3 * N; i++) { const a = i % 3; pos[i] = b.lo[a] + qp[i] / 65535 * b.span[a]; }
    const sc = new Uint16Array(buf, o, 3 * N); o += 6 * N;
    const rgba = new Uint8Array(buf, o, 4 * N); o += 4 * N;
    const quat = new Uint8Array(buf, o, 4 * N); o += 4 * N;
    const aview = new Uint8Array(buf, o, M);
    // four RGBA32F texels per Gaussian: (xyz, opacity) (c00 c01 c02 c11) (c12 c22 - -) (rgb -)
    const rows = Math.ceil(4 * N / TEX_W), tex = new Float32Array(TEX_W * rows * 4);
    for (let i = 0; i < N; i++) {
      let w = quat[4 * i] / 128 - 1, x = quat[4 * i + 1] / 128 - 1, y = quat[4 * i + 2] / 128 - 1, z = quat[4 * i + 3] / 128 - 1;
      const qn = Math.hypot(w, x, y, z) || 1; w /= qn; x /= qn; y /= qn; z /= qn;
      const sx = h2f(sc[3 * i]), sy = h2f(sc[3 * i + 1]), sz = h2f(sc[3 * i + 2]);
      const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y);
      const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x);
      const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y);
      const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz, m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
      const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;
      const k = 16 * i;
      tex[k] = pos[3 * i]; tex[k + 1] = pos[3 * i + 1]; tex[k + 2] = pos[3 * i + 2]; tex[k + 3] = rgba[4 * i + 3] / 255;
      tex[k + 4] = m00 * m00 + m01 * m01 + m02 * m02; tex[k + 5] = m00 * m10 + m01 * m11 + m02 * m12;
      tex[k + 6] = m00 * m20 + m01 * m21 + m02 * m22; tex[k + 7] = m10 * m10 + m11 * m11 + m12 * m12;
      tex[k + 8] = m10 * m20 + m11 * m21 + m12 * m22; tex[k + 9] = m20 * m20 + m21 * m21 + m22 * m22;
      tex[k + 12] = rgba[4 * i] / 255; tex[k + 13] = rgba[4 * i + 1] / 255; tex[k + 14] = rgba[4 * i + 2] / 255;
    }
    const ainst = new Float32Array(M * 6);
    for (let j = 0; j < M; j++) {
      ainst.set([axyz[3 * j], axyz[3 * j + 1], axyz[3 * j + 2], rho[j], aview[j], j], 6 * j);
    }
    return { N, M, K: b.K, pos, axyz, rho, aview, tex, rows, ainst, sc };
  }

  // ---------------------------------------------------------------- small vector helpers
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
  function rot(v, k, ang) {           // Rodrigues, k unit
    const c = Math.cos(ang), s = Math.sin(ang);
    return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
  }
  function matToQuat(r, d, f) {       // rows of world->camera rotation
    const m = [[r[0], r[1], r[2]], [d[0], d[1], d[2]], [f[0], f[1], f[2]]];
    const tr = m[0][0] + m[1][1] + m[2][2]; let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]; }
    else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]; }
    else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]; }
    else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s]; }
    return q;
  }
  function quatToRows(q) {
    const [w, x, y, z] = q;
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  }
  function slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map(v => -v); d = -d; }
    if (d > 0.9995) { const q = a.map((v, i) => v + t * (b[i] - v)); const n = Math.hypot(...q); return q.map(v => v / n); }
    const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map((v, i) => wa * v + wb * b[i]);
  }

  // ---------------------------------------------------------------- WebGL
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  if (!gl) {
    document.getElementById('status').textContent = 'This viewer needs WebGL 2. Please open it in a recent Chrome, Edge, Firefox or Safari.';
    return;
  }
  gl.getExtension('EXT_color_buffer_float');

  const SPLAT_VS = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D uTex;
uniform mat4 uView; uniform vec2 uFocal, uViewport, uPrincipal;
uniform int uK, uSel, uFocus, uGroups; uniform float uDim;
in vec2 aCorner; in uint aIndex;
out vec4 vColor; out vec2 vPos;
ivec2 tc(uint t) { return ivec2(int(t % ${TEX_W}u), int(t / ${TEX_W}u)); }
vec3 hsv2rgb(vec3 c) { vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
void main() {
  uint base = aIndex * 4u;
  int owner = int(aIndex) / uK;
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  if (uSel >= 0 && uFocus == 2 && owner != uSel) return;
  vec4 t0 = texelFetch(uTex, tc(base), 0);
  vec4 cam = uView * vec4(t0.xyz, 1.0);
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  if (cam.z < 0.02) return;
  vec4 t1 = texelFetch(uTex, tc(base + 1u), 0), t2 = texelFetch(uTex, tc(base + 2u), 0), t3 = texelFetch(uTex, tc(base + 3u), 0);
  mat3 S = mat3(t1.x, t1.y, t1.z, t1.y, t1.w, t2.x, t1.z, t2.x, t2.y);
  float z = cam.z;
  vec2 lim = 1.3 * 0.5 * uViewport / uFocal;
  float tx = clamp(cam.x / z, -lim.x, lim.x) * z, ty = clamp(cam.y / z, -lim.y, lim.y) * z;
  mat3 J = mat3(uFocal.x / z, 0.0, 0.0, 0.0, uFocal.y / z, 0.0, -uFocal.x * tx / (z * z), -uFocal.y * ty / (z * z), 0.0);
  mat3 T = J * mat3(uView);
  mat3 C = T * S * transpose(T);
  float a = C[0][0] + 0.3, b = C[0][1], c = C[1][1] + 0.3;
  float mid = 0.5 * (a + c), rad = length(vec2(0.5 * (a - c), b));
  float l1 = mid + rad, l2 = mid - rad;
  if (l2 <= 0.0) return;
  vec2 d1 = abs(b) < 1e-12 ? (a >= c ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 d2 = vec2(d1.y, -d1.x);
  vec2 px = vec2(uFocal.x * cam.x / z, uFocal.y * cam.y / z) + uPrincipal;
  vec2 p = px + aCorner.x * min(sqrt(2.0 * l1), 1024.0) * d1 + aCorner.y * min(sqrt(2.0 * l2), 1024.0) * d2;
  gl_Position = vec4(2.0 * p.x / uViewport.x - 1.0, 1.0 - 2.0 * p.y / uViewport.y, 0.0, 1.0);
  vPos = aCorner;
  vec3 col = t3.rgb; float op = t0.w;
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  if (uGroups == 1) col = hsv2rgb(vec3(fract(float(owner) * 0.61803398875 + 0.13), 0.78, 0.62 + 0.38 * fract(float(owner) * 0.7548776662))) * (0.45 + 0.7 * luma);
  if (uSel >= 0 && owner != uSel) { op *= uDim; col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), 0.75) * 0.75 + 0.12; }
  vColor = vec4(col, op);
}`;
  const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 vColor; in vec2 vPos; out vec4 frag;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float al = min(0.99, vColor.a * exp(A));
  if (al < 1.0 / 255.0) discard;
  frag = vec4(vColor.rgb * al, al);
}`;
  const ANCHOR_VS = `#version 300 es
precision highp float;
uniform mat4 uView; uniform vec2 uFocal, uViewport, uPrincipal;
uniform float uRadiusPx, uCount, uM, uRhoLo, uRhoHi, uSelRank; uniform int uMode, uOnlyRoles;
uniform float uNb[8];
uniform vec3 uViewRGB[6];
in vec2 aCorner; in vec3 aXYZ; in float aRho, aView, aRank;
out vec2 vPos; out vec3 vCol; flat out int vRole;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.267, 0.005, 0.329), c1 = vec3(0.230, 0.322, 0.546), c2 = vec3(0.128, 0.567, 0.551), c3 = vec3(0.369, 0.789, 0.383), c4 = vec3(0.993, 0.906, 0.144);
  float s = t * 4.0;
  if (s < 1.0) return mix(c0, c1, s); if (s < 2.0) return mix(c1, c2, s - 1.0);
  if (s < 3.0) return mix(c2, c3, s - 2.0); return mix(c3, c4, s - 3.0);
}
void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  int role = abs(aRank - uSelRank) < 0.5 ? 2 : 0;
  for (int i = 0; i < 8; i++) if (role == 0 && abs(aRank - uNb[i]) < 0.5) role = 1;
  vRole = role;
  if (uOnlyRoles == 1 && role == 0) return;
  if (role == 0 && aRank >= uCount) return;
  vec4 cam = uView * vec4(aXYZ, 1.0);
  if (cam.z < 0.02) return;
  vec2 px = vec2(uFocal.x * cam.x / cam.z, uFocal.y * cam.y / cam.z) + uPrincipal;
  float r = uRadiusPx * (role == 2 ? 2.1 : role == 1 ? 1.45 : 1.0);
  vec2 p = px + aCorner * r;
  float zc = clamp(cam.z / 100.0, 0.0, 1.0) * 2.0 - 1.0;
  gl_Position = vec4(2.0 * p.x / uViewport.x - 1.0, 1.0 - 2.0 * p.y / uViewport.y, role > 0 ? -1.0 + 0.001 * float(2 - role) : zc, 1.0);
  vPos = aCorner;
  if (uMode == 0) vCol = uViewRGB[int(aView + 0.5)];
  else if (uMode == 1) vCol = ramp((log(aRho) - uRhoLo) / max(uRhoHi - uRhoLo, 1e-6));
  else if (uMode == 2) vCol = ramp(aRank / max(uM - 1.0, 1.0));
  else vCol = vec3(1.0);
}`;
  const ANCHOR_FS = `#version 300 es
precision highp float;
in vec2 vPos; in vec3 vCol; flat in int vRole; out vec4 frag;
void main() {
  float r = length(vPos);
  if (r > 1.0) discard;
  if (vRole == 2) { frag = vec4(r > 0.62 ? vec3(0.07, 0.42, 0.48) : vec3(1.0), 1.0); return; }
  if (vRole == 1) { frag = vec4(r > 0.66 ? vec3(0.98, 0.72, 0.18) : vCol, 1.0); return; }
  frag = vec4(r > 0.78 ? vCol * 0.45 : vCol, 1.0);
}`;
  // Screen-space line segments (constant pixel width): the anchor's offset box and its k-NN links.
  const LINE_VS = `#version 300 es
precision highp float;
uniform mat4 uView; uniform vec2 uFocal, uViewport, uPrincipal; uniform float uWidth;
in vec2 aCorner; in vec3 aP0, aP1; in vec4 aCol;
out vec4 vCol; out float vSide;
vec2 proj(vec4 c) { return vec2(uFocal.x * c.x / c.z, uFocal.y * c.y / c.z) + uPrincipal; }
void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vec4 c0 = uView * vec4(aP0, 1.0), c1 = uView * vec4(aP1, 1.0);
  float n = 0.03;
  if (c0.z < n && c1.z < n) return;
  if (c0.z < n) c0 = mix(c0, c1, (n - c0.z) / (c1.z - c0.z));
  if (c1.z < n) c1 = mix(c1, c0, (n - c1.z) / (c0.z - c1.z));
  vec2 a = proj(c0), b = proj(c1), d = b - a; float L = length(d);
  if (L < 1e-6) return;
  vec2 nrm = vec2(-d.y, d.x) / L;
  vec2 p = mix(a, b, aCorner.x) + nrm * aCorner.y * uWidth * aCol.a * 0.5 * 2.0;
  gl_Position = vec4(2.0 * p.x / uViewport.x - 1.0, 1.0 - 2.0 * p.y / uViewport.y, 0.0, 1.0);
  vCol = aCol; vSide = aCorner.y;
}`;
  const LINE_FS = `#version 300 es
precision highp float;
in vec4 vCol; in float vSide; out vec4 frag;
void main() { float a = 1.0 - smoothstep(0.55, 1.0, abs(vSide)); frag = vec4(vCol.rgb * a, a); }`;

  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  const splatProg = compile(SPLAT_VS, SPLAT_FS), anchorProg = compile(ANCHOR_VS, ANCHOR_FS), lineProg = compile(LINE_VS, LINE_FS);
  const quad = new Float32Array([-2, -2, 2, -2, 2, 2, -2, -2, 2, 2, -2, 2]);
  const unitQuad = quad.map(v => v / 2);

  const splatVAO = gl.createVertexArray(); gl.bindVertexArray(splatVAO);
  const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  let loc = gl.getAttribLocation(splatProg.p, 'aCorner'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const idxBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
  loc = gl.getAttribLocation(splatProg.p, 'aIndex'); gl.enableVertexAttribArray(loc); gl.vertexAttribIPointer(loc, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(loc, 1);

  const anchorVAO = gl.createVertexArray(); gl.bindVertexArray(anchorVAO);
  const uqb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, uqb); gl.bufferData(gl.ARRAY_BUFFER, unitQuad, gl.STATIC_DRAW);
  loc = gl.getAttribLocation(anchorProg.p, 'aCorner'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const aBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, aBuf);
  [['aXYZ', 3, 0], ['aRho', 1, 12], ['aView', 1, 16], ['aRank', 1, 20]].forEach(([n, sz, off]) => {
    const l = gl.getAttribLocation(anchorProg.p, n); gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, sz, gl.FLOAT, false, 24, off); gl.vertexAttribDivisor(l, 1);
  });
  const dotVAO = gl.createVertexArray(); gl.bindVertexArray(dotVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, uqb);
  loc = gl.getAttribLocation(anchorProg.p, 'aCorner'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const dBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, dBuf);
  [['aXYZ', 3, 0], ['aRho', 1, 12], ['aView', 1, 16], ['aRank', 1, 20]].forEach(([n, sz, off]) => {
    const l = gl.getAttribLocation(anchorProg.p, n); gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, sz, gl.FLOAT, false, 24, off); gl.vertexAttribDivisor(l, 1);
  });
  let dotCount = 0;
  const lineVAO = gl.createVertexArray(); gl.bindVertexArray(lineVAO);
  const lqb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lqb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]), gl.STATIC_DRAW);
  loc = gl.getAttribLocation(lineProg.p, 'aCorner'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const lBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lBuf);
  [['aP0', 3, 0], ['aP1', 3, 12], ['aCol', 4, 24]].forEach(([n, sz, off]) => {
    const l = gl.getAttribLocation(lineProg.p, n); gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, sz, gl.FLOAT, false, 40, off); gl.vertexAttribDivisor(l, 1);
  });
  let lineCount = 0;
  gl.bindVertexArray(null);
  const tex = gl.createTexture();

  // ---------------------------------------------------------------- state
  const S = {
    scene: null, budget: null, data: null, show: 'gauss', colorMode: 0, count: 0, sel: -1,
    cam: null, target: null, up: [0, -1, 0], sortedFor: null, order: null, dirty: true,
    path: 0, playing: false, growing: false, loadToken: 0, V: 4, hover: -1, focus: 'dim', nb: [], rhoTab: null, tgtShown: -2,
  };

  function camFromW2C(w) {
    const r = [w[0][0], w[0][1], w[0][2]], d = [w[1][0], w[1][1], w[1][2]], f = [w[2][0], w[2][1], w[2][2]];
    const t = [w[0][3], w[1][3], w[2][3]];
    const P = mul(add(add(mul(r, t[0]), mul(d, t[1])), mul(f, t[2])), -1);
    return { r, d, f, P };
  }
  function viewMatrix(c) {             // column-major world->camera
    const t = [-dot(c.r, c.P), -dot(c.d, c.P), -dot(c.f, c.P)];
    return new Float32Array([c.r[0], c.d[0], c.f[0], 0, c.r[1], c.d[1], c.f[1], 0, c.r[2], c.d[2], c.f[2], 0, t[0], t[1], t[2], 1]);
  }
  function medianDepth(c) {
    const pos = S.data.pos, n = S.data.N, step = Math.max(1, Math.floor(n / 3000)), zs = [];
    for (let i = 0; i < n; i += step) { const z = dot(c.f, sub([pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], c.P)); if (z > 0.05) zs.push(z); }
    zs.sort((a, b) => a - b); return zs.length ? zs[zs.length >> 1] : 1;
  }
  function overviewCam() {            // raised three-quarter view of the whole reconstruction
    const cams = inputCams(), d = S.data, M = d.M;
    const C = mul(cams.reduce((a, c) => add(a, c.P), [0, 0, 0]), 1 / cams.length);
    const xs = [0, 1, 2].map(k => { const v = []; for (let j = 0; j < M; j++) v.push(d.axyz[3 * j + k]); v.sort((a, b) => a - b); return v[v.length >> 1]; });
    const T = xs, L = Math.hypot(...sub(T, C)), fwd = norm(sub(T, C)), U = norm(S.up);
    const P = add(sub(C, mul(fwd, 0.35 * L)), mul(U, 0.5 * L));
    const f = norm(sub(T, P)); let dn = mul(U, -1); dn = norm(sub(dn, mul(f, dot(dn, f))));
    return { cam: { r: cross(dn, f), d: dn, f, P }, depth: Math.hypot(...sub(T, P)) };
  }
  const sv = () => S.scene.views[S.V];
  function inputCams() { return sv().inputs.map(v => camFromW2C(v.w2c)); }
  function setCam(c, depth) { S.cam = c; S.target = add(c.P, mul(c.f, depth || medianDepth(c))); S.dirty = true; }
  function pathCam(s) {
    const cams = inputCams(), n = cams.length, i = Math.min(Math.floor(s), n - 2), u = s - i;
    const a = cams[i], b = cams[i + 1];
    const q = slerp(matToQuat(a.r, a.d, a.f), matToQuat(b.r, b.d, b.f), u), R = quatToRows(q);
    return { r: R[0], d: R[1], f: R[2], P: add(mul(a.P, 1 - u), mul(b.P, u)) };
  }

  // ---------------------------------------------------------------- sorting (back to front)
  function sortSplats() {
    const d = S.data, c = S.cam, n = d.N, pos = d.pos;
    const depth = new Float32Array(n); let lo = Infinity, hi = -Infinity;
    const f = c.f, off = dot(f, c.P);
    for (let i = 0; i < n; i++) {
      const z = f[0] * pos[3 * i] + f[1] * pos[3 * i + 1] + f[2] * pos[3 * i + 2] - off;
      depth[i] = z; if (z < lo) lo = z; if (z > hi) hi = z;
    }
    const B = 65536, cnt = new Uint32Array(B), key = new Uint32Array(n), sc = (B - 1) / Math.max(hi - lo, 1e-9);
    for (let i = 0; i < n; i++) { key[i] = (B - 1) - Math.floor((depth[i] - lo) * sc); cnt[key[i]]++; }
    for (let i = 1; i < B; i++) cnt[i] += cnt[i - 1];
    const order = new Uint32Array(n);
    for (let i = n - 1; i >= 0; i--) order[--cnt[key[i]]] = i;
    gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf); gl.bufferData(gl.ARRAY_BUFFER, order, gl.DYNAMIC_DRAW);
  }

  // ---------------------------------------------------------------- draw
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; S.dirty = true; }
  }
  function intr() {
    const K = sv().inputs[0].K, hw = sv().hw, s = canvas.height / hw[0];
    return { fx: K[0] * s, fy: K[1] * s, cx: canvas.width / 2 + (K[2] - hw[1] / 2) * s, cy: canvas.height / 2 + (K[3] - hw[0] / 2) * s };
  }
  const selectable = () => S.show !== 'gauss';
  const target = () => (S.sel >= 0 ? S.sel : (selectable() ? S.hover : -1));
  function draw() {
    resize();
    if (!S.data || !S.dirty) return;
    S.dirty = false;
    const bg = MAN.bg, k = intr(), V = viewMatrix(S.cam), d = S.data, tgt = target();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const setCamU = pr => {
      gl.uniformMatrix4fv(pr.u.uView, false, V);
      gl.uniform2f(pr.u.uFocal, k.fx, k.fy); gl.uniform2f(pr.u.uViewport, canvas.width, canvas.height);
      gl.uniform2f(pr.u.uPrincipal, k.cx, k.cy);
    };
    if (S.show !== 'anchors' || tgt >= 0) {
      sortSplats();
      gl.useProgram(splatProg.p); gl.bindVertexArray(splatVAO);
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(splatProg.u.uTex, 0);
      setCamU(splatProg);
      gl.uniform1i(splatProg.u.uK, d.K); gl.uniform1i(splatProg.u.uSel, tgt); gl.uniform1f(splatProg.u.uDim, 0.2);
      gl.uniform1i(splatProg.u.uFocus, S.show === 'anchors' || S.focus === 'hide' ? 2 : 1);
      gl.uniform1i(splatProg.u.uGroups, S.show === 'groups' ? 1 : 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.N);
    }
    if (tgt >= 0 && lineCount) {
      gl.useProgram(lineProg.p); gl.bindVertexArray(lineVAO);
      gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      setCamU(lineProg); gl.uniform1f(lineProg.u.uWidth, Math.max(1.5, canvas.height / 420));
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, lineCount);
    }
    const anchorsOn = S.show === 'both' || S.show === 'anchors';
    if (tgt >= 0 && dotCount) {
      gl.useProgram(anchorProg.p); gl.bindVertexArray(dotVAO); setCamU(anchorProg);
      gl.uniform1f(anchorProg.u.uRadiusPx, Math.max(2.4, canvas.height / 240)); gl.uniform1f(anchorProg.u.uCount, 1e9);
      gl.uniform1i(anchorProg.u.uMode, 3); gl.uniform1f(anchorProg.u.uSelRank, -1); gl.uniform1i(anchorProg.u.uOnlyRoles, 0);
      gl.uniform1fv(anchorProg.u.uNb, new Float32Array(8).fill(-10));
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, dotCount);
    }
    if (anchorsOn || tgt >= 0) {
      gl.useProgram(anchorProg.p); gl.bindVertexArray(anchorVAO);
      setCamU(anchorProg);
      gl.uniform1f(anchorProg.u.uRadiusPx, Math.max(3.0, canvas.height / 150)); gl.uniform1f(anchorProg.u.uCount, S.count);
      gl.uniform1f(anchorProg.u.uM, d.M); gl.uniform1i(anchorProg.u.uMode, S.colorMode);
      gl.uniform1f(anchorProg.u.uRhoLo, Math.log(0.03)); gl.uniform1f(anchorProg.u.uRhoHi, Math.log(0.5));
      gl.uniform1f(anchorProg.u.uSelRank, tgt); gl.uniform1i(anchorProg.u.uOnlyRoles, anchorsOn && !(tgt >= 0 && S.focus === 'hide') ? 0 : 1);
      const nb = new Float32Array(8).fill(-10); (tgt >= 0 ? S.nb : []).forEach((v, i) => { nb[i] = v; });
      gl.uniform1fv(anchorProg.u.uNb, nb);
      gl.uniform3fv(anchorProg.u.uViewRGB, new Float32Array([].concat(...VIEW_RGB)));
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.M);
    }
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- anchor inspection
  // Exact geometry from the decoder: centre = anchor + rho * tanh(.) per world axis, so the 36
  // centres of an anchor lie in the axis-aligned cube of half-width rho; each scale is capped
  // at min(rho, 0.075). rho = mean distance to the 8 nearest selected anchors, clamped to [0.03, 0.5].
  const RHO_K = 8, SCALE_CAP = 0.075;
  function inspect(j) {
    const d = S.data, p = [d.axyz[3 * j], d.axyz[3 * j + 1], d.axyz[3 * j + 2]], r = d.rho[j];
    const dist = [];
    for (let i = 0; i < d.M; i++) if (i !== j) dist.push([Math.hypot(d.axyz[3 * i] - p[0], d.axyz[3 * i + 1] - p[1], d.axyz[3 * i + 2] - p[2]), i]);
    dist.sort((a, b) => a[0] - b[0]);
    const nn = dist.slice(0, RHO_K);
    const rhoRe = Math.min(0.5, Math.max(0.03, nn.reduce((a, x) => a + x[0], 0) / Math.max(nn.length, 1)));
    let inside = 0, maxOff = 0, maxScale = 0;
    for (let g = j * d.K; g < (j + 1) * d.K; g++) {
      let m = 0;
      for (let a = 0; a < 3; a++) { m = Math.max(m, Math.abs(d.pos[3 * g + a] - p[a])); maxScale = Math.max(maxScale, h2f(d.sc[3 * g + a])); }
      maxOff = Math.max(maxOff, m / r); if (m <= r * 1.01) inside++;
    }
    return { j, p, r, nn: nn.map(x => x[1]), rhoRe, inside, maxOff, maxScale, cap: Math.min(r, SCALE_CAP) };
  }
  function buildLines(info) {
    const segs = [], { p, r } = info, d = S.data;
    const push = (a, b, col, w) => segs.push(...a, ...b, ...col, w);
    for (const j of info.nn) {
      const q = [d.axyz[3 * j], d.axyz[3 * j + 1], d.axyz[3 * j + 2]];
      push(p, q, [0, 0, 0], 1.9); push(p, q, [0.98, 0.72, 0.18], 1.0);
    }
    const c = [];
    for (let i = 0; i < 8; i++) c.push([p[0] + (i & 1 ? r : -r), p[1] + (i & 2 ? r : -r), p[2] + (i & 4 ? r : -r)]);
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of edges) push(c[a], c[b], [0, 0, 0], 2.2);
    for (const [a, b] of edges) push(c[a], c[b], [1, 1, 1], 1.2);
    gl.bindBuffer(gl.ARRAY_BUFFER, lBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segs), gl.DYNAMIC_DRAW);
    lineCount = segs.length / 10;
    const j = info.j, dots = new Float32Array(d.K * 6);
    for (let g = 0; g < d.K; g++) { const i = j * d.K + g; dots.set([d.pos[3 * i], d.pos[3 * i + 1], d.pos[3 * i + 2], 0.1, 0, -100], 6 * g); }
    gl.bindBuffer(gl.ARRAY_BUFFER, dBuf); gl.bufferData(gl.ARRAY_BUFFER, dots, gl.DYNAMIC_DRAW); dotCount = d.K;
  }
  function zoomTo(info) {             // keep the viewing direction, bring the anchor's box to fill the view
    stopPlay(); const c = S.cam, dist = Math.max(7 * info.r, 0.12);
    S.target = info.p.slice(); c.P = sub(info.p, mul(c.f, dist)); S.dirty = true;
  }
  function rhoChart(j) {
    const bs = sv().budgets, tab = S.rhoTab; if (!tab) return '';
    const W = 260, H = 92, pad = 20, bw = (W - 2 * pad) / bs.length;
    const top = Math.max(...bs.map((b, i) => (j < b.M ? tab[i][j] : 0))) / 0.85 || 0.5;
    let bars = '';
    bs.forEach((b, i) => {
      const x = pad + i * bw + bw * 0.2, w = bw * 0.6, cur = i === S.budget;
      const lab = `<text x="${x + w / 2}" y="${H - 4}" text-anchor="middle" class="ax">${fmt(b.M)}</text>`;
      if (j >= b.M) { bars += `<rect x="${x}" y="${H - 20}" width="${w}" height="1" class="none"/>${lab}<text x="${x + w / 2}" y="${H - 24}" text-anchor="middle" class="ax">–</text>`; return; }
      const v = tab[i][j], h = (H - 38) * v / top;
      bars += `<rect x="${x}" y="${H - 16 - h}" width="${w}" height="${h}" rx="2" class="${cur ? 'cur' : 'bar'}"/>` +
              `<text x="${x + w / 2}" y="${H - 20 - h}" text-anchor="middle" class="val${cur ? ' c' : ''}">${v.toFixed(2)}</text>${lab}`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="rho-chart" role="img" aria-label="Local scale of this anchor at each budget">${bars}</svg>`;
  }
  function updateTarget(force) {
    const t = target();
    if (!S.data) return;
    if (t === S.tgtShown && !force) return;
    S.tgtShown = t; S.dirty = true;
    const box = $('selInfo');
    if (t < 0) { lineCount = 0; dotCount = 0; S.nb = []; box.classList.remove('on'); box.innerHTML = $('selEmpty').innerHTML; return; }
    const d = S.data, info = inspect(t); S.nb = info.nn; buildLines(info); box.classList.add('on');
    const vc = 'rgb(' + VIEW_RGB[d.aview[t]].map(x => Math.round(x * 255)).join(',') + ')';
    box.innerHTML = `<div class="sel-head"><b>Anchor ${fmt(t + 1)}</b><span>of ${fmt(d.M)} &middot; allocation order</span>` +
      `<span class="vchip" style="--vc:${vc}">view ${d.aview[t] + 1}</span>${S.sel >= 0 ? '<span class="sel-btns"><button type="button" class="btn sm" id="zoomSel">Zoom in</button><button type="button" class="btn sm" id="unpin">Clear</button></span>' : '<span class="hov">hover &middot; click to pin</span>'}</div>` +
      `<div class="sel-grid"><div><span>Local scale &rho;</span><b>${d.rho[t].toFixed(3)}</b></div>` +
      `<div><span>Centers inside the &rho;-box (1% rounding)</span><b>${info.inside} / ${d.K}</b></div>` +
      `<div><span>Largest offset / &rho;</span><b>${info.maxOff.toFixed(2)}</b></div>` +
      `<div><span>Largest scale (cap ${info.cap.toFixed(3)})</span><b>${info.maxScale.toFixed(3)}</b></div></div>` +
      `<div class="sel-chart"><span>&rho; of this anchor at each budget</span>${rhoChart(t)}</div>` +
      `<p class="sel-note">Its ${d.K} Gaussians stay highlighted and their centers are marked with white dots. The white box is the region their centers are confined to
       (half-width &rho;); orange lines join the ${info.nn.length} nearest anchors whose mean distance sets &rho;.</p>`;
    const u = $('unpin'); if (u) u.onclick = () => select(-1);
    const z = $('zoomSel'); if (z) z.onclick = () => zoomTo(info);
    $('focusRow').hidden = false;
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (S.playing && S.data) {
      const n = sv().inputs.length - 1;
      S.path += S.dir * dt * 0.22;
      if (S.path >= n) { S.path = n; S.dir = -1; } if (S.path <= 0) { S.path = 0; S.dir = 1; }
      ui.path.value = S.path; setCam(pathCam(S.path), S.pathDepth);
    }
    if (S.growing && S.data) {
      S.count = Math.min(S.data.M, S.count + Math.max(1, S.data.M * dt / 4));
      if (S.count >= S.data.M) S.growing = false;
      syncCount(); S.dirty = true;
    }
    if (S.hoverReq && S.data) { const e = S.hoverReq; S.hoverReq = null; const j = selectable() ? nearestAnchor(e) : -1; if (j !== S.hover) { S.hover = j; updateTarget(); } }
    draw(); requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- interaction
  let drag = null;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey };
    stopPlay();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag && e.pointerType === 'mouse') { S.hoverReq = { clientX: e.clientX, clientY: e.clientY }; return; }
    if (!drag || !S.cam) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    const c = S.cam;
    if (drag.pan) {
      const dist = Math.hypot(...sub(S.target, c.P)), s = dist / (canvas.clientHeight * 0.8);
      const m = add(mul(c.r, -dx * s), mul(c.d, -dy * s));
      c.P = add(c.P, m); S.target = add(S.target, m);
    } else {
      const U = norm(S.up), ya = -dx * 0.006, pa = dy * 0.006;
      let off = sub(c.P, S.target);
      off = rot(off, U, ya); c.r = rot(c.r, U, ya); c.d = rot(c.d, U, ya); c.f = rot(c.f, U, ya);
      off = rot(off, c.r, pa); c.d = rot(c.d, c.r, pa); c.f = rot(c.f, c.r, pa);
      c.P = add(S.target, off);
    }
    S.dirty = true;
  });
  canvas.addEventListener('pointerleave', () => { if (S.hover >= 0) { S.hover = -1; updateTarget(); } });
  canvas.addEventListener('pointerup', e => {
    if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) pick(e);
    drag = null;
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); if (!S.cam) return;
    const c = S.cam, off = sub(c.P, S.target), s = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0015);
    c.P = add(S.target, mul(off, s)); S.dirty = true; stopPlay();
  }, { passive: false });

  function nearestAnchor(e) {
    const rect = canvas.getBoundingClientRect(), dpr = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * dpr, my = (e.clientY - rect.top) * dpr, k = intr(), c = S.cam, d = S.data;
    const lim = S.show === 'groups' ? 22 : 14;
    let best = -1, bestD = (lim * dpr) ** 2, bestZ = Infinity;
    const n = S.show === 'groups' ? d.M : Math.floor(S.count);
    for (let j = 0; j < n; j++) {
      const rel = sub([d.axyz[3 * j], d.axyz[3 * j + 1], d.axyz[3 * j + 2]], c.P), z = dot(c.f, rel);
      if (z < 0.02) continue;
      const u = k.fx * dot(c.r, rel) / z + k.cx, v = k.fy * dot(c.d, rel) / z + k.cy, dd = (u - mx) ** 2 + (v - my) ** 2;
      if (dd < bestD * 0.6 || (dd < bestD && z < bestZ)) { best = j; bestD = Math.max(dd, 1); bestZ = z; }
    }
    return best;
  }
  function pick(e) {
    if (!S.data || !selectable()) { select(-1); return; }
    const j = nearestAnchor(e);
    select(j === S.sel ? -1 : j);
  }

  // ---------------------------------------------------------------- UI wiring
  const $ = id => document.getElementById(id);
  const ui = { path: $('path'), count: $('count'), countVal: $('countVal'), stats: $('stats'), sel: $('selInfo'), status: $('status') };
  const fmt = n => n.toLocaleString('en-US');
  function select(j) {
    S.sel = j; if (j < 0) S.hover = -1;
    $('focusRow').hidden = j < 0;
    updateTarget(true);
  }
  function syncCount() {
    ui.count.max = S.data.M; ui.count.value = Math.floor(S.count);
    ui.countVal.textContent = fmt(Math.floor(S.count)) + ' / ' + fmt(S.data.M);
  }
  function setSegment(group, val) {
    document.querySelectorAll('[data-group="' + group + '"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.val === String(val))));
  }
  function stopPlay() { S.playing = false; $('play').textContent = 'Play'; }

  async function showBudget(bi) {
    const b = sv().budgets[bi], token = ++S.loadToken, key = S.scene.id + '/' + S.V + '/' + b.M;
    ui.status.textContent = 'Loading ' + fmt(b.N) + ' Gaussians…';
    let buf;
    try { buf = await fetchBudget(key, b); } catch (err) { ui.status.textContent = err.message; return; }
    if (token !== S.loadToken) return;
    const d = parse(buf, b);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, d.rows, 0, gl.RGBA, gl.FLOAT, d.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, aBuf); gl.bufferData(gl.ARRAY_BUFFER, d.ainst, gl.STATIC_DRAW);
    const tag = S.scene.id + '/' + S.V, firstLoad = !S.data || S.data.tag !== tag;
    if (firstLoad) { S.sel = -1; loadRho(); }
    d.tag = tag; S.data = d; S.budget = bi;
    S.count = d.M; syncCount();
    if (S.sel >= d.M) S.sel = -1;
    S.hover = -1; select(S.sel);
    if (firstLoad) { setCam(inputCams()[0]); S.pathDepth = medianDepth(S.cam); }
    setSegment('budget', bi);
    ui.stats.innerHTML = `<div><span>Gaussians</span><b>${fmt(d.N)}</b></div><div><span>Anchors M</span><b>${fmt(d.M)}</b></div>` +
      `<div><span>PSNR, held-out views</span><b>${b.psnr.toFixed(2)} dB</b></div><div><span>Median &rho;</span><b>${b.rho_median.toFixed(3)}</b></div>`;
    ui.status.textContent = '';
    S.dirty = true;
  }
  async function loadRho() {
    const v = sv(), key = S.scene.id + '/' + S.V + '/rho', want = key; S.rhoTab = null;
    if (!v.rho) return;
    const buf = await fetchBudget(key, { file: v.rho });
    if (want !== S.scene.id + '/' + S.V + '/rho') return;
    let o = 0; S.rhoTab = v.budgets.map(b => { const a = new Float32Array(buf, o, b.M); o += 4 * b.M; return a; });
    updateTarget(true);
  }
  function defaultBudget() { return Math.max(0, sv().budgets.findIndex(b => b.default)); }
  function showScene(si, keepBudget) {
    S.scene = MAN.scenes[si]; S.sceneIndex = si; S.sel = -1; S.path = 0; ui.path.value = 0; ui.path.max = sv().inputs.length - 1;
    buildBudgets();
    stopPlay();
    document.querySelectorAll('.scene-card').forEach((el, i) => el.setAttribute('aria-pressed', String(i === si)));
    $('sceneName').textContent = S.scene.label;
    $('sceneId').textContent = 'DL3DV ' + S.scene.id;
    // world up = mean of the input cameras' up directions (OpenCV: -y)
    S.up = norm(sv().inputs.map(v => [-v.w2c[1][0], -v.w2c[1][1], -v.w2c[1][2]]).reduce(add, [0, 0, 0]));
    const views = $('views'); views.innerHTML = '';
    views.style.gridTemplateColumns = 'repeat(' + (sv().inputs.length <= 4 ? sv().inputs.length : 3) + ', 1fr)';
    sv().inputs.forEach((v, i) => {
      const b = document.createElement('button'); b.className = 'view-thumb'; b.type = 'button';
      b.style.setProperty('--vc', 'rgb(' + VIEW_RGB[i].map(x => Math.round(x * 255)).join(',') + ')');
      b.title = 'Jump to input view ' + (i + 1);
      b.innerHTML = `<img src="${v.img}" alt="Input view ${i + 1}"><span>${i + 1}</span>`;
      b.onclick = () => { stopPlay(); S.path = i; ui.path.value = i; setCam(inputCams()[i]); };
      views.appendChild(b);
    });
    const bv = $('budgetVideo'), src = sv().videos && sv().videos.budgets;
    bv.parentElement.hidden = !src;
    bv.style.aspectRatio = sv().budgets.length + ' / 1';
    if (src && bv.getAttribute('src') !== src) { bv.setAttribute('src', src); bv.play().catch(() => {}); }
    $('bvScene').textContent = S.scene.label;
    showBudget(keepBudget && S.budget != null && S.budget < sv().budgets.length ? S.budget : defaultBudget());
  }

  // scene gallery, fly-through gallery and budget buttons depend on the view count
  const gal = $('scenes'), fg = $('flyGrid'), bw = $('budgets');
  function buildScenes() {
    gal.innerHTML = '';
    MAN.scenes.forEach((sc, i) => {
      const v = sc.views[S.V], d = v.budgets.find(x => x.default) || v.budgets[0];
      const b = document.createElement('button'); b.type = 'button'; b.className = 'scene-card';
      b.setAttribute('aria-pressed', String(i === S.sceneIndex));
      b.innerHTML = `<img src="${v.inputs[0].img}" alt=""><span class="sc-name">${sc.label}</span><span class="sc-psnr">${d.psnr.toFixed(2)} dB</span>`;
      b.onclick = () => showScene(i);
      gal.appendChild(b);
    });
  }
  function buildGallery() {
    fg.innerHTML = '';
    let d0 = null;
    MAN.scenes.forEach((sc, i) => {
      const v = sc.views[S.V]; if (!v.videos || !v.videos.main) return;
      const d = v.budgets.find(x => x.default); d0 = d;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fly-card';
      b.innerHTML = `<video src="${v.videos.main}" muted loop playsinline autoplay preload="metadata"></video>` +
        `<span>${sc.label} &middot; ${d.psnr.toFixed(2)} dB</span>`;
      b.onclick = () => { showScene(i); document.querySelector('.viewer').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      fg.appendChild(b);
    });
    fg.parentElement.hidden = !fg.children.length;
    if (d0) $('flyTitle').textContent = `Fly-throughs · ${S.V} input views · M = ${fmt(d0.M)} (${(d0.N / 1000).toFixed(1)}K Gaussians)`;
  }
  function buildBudgets() {
    bw.innerHTML = '';
    sv().budgets.forEach((b, i) => {
      const el = document.createElement('button'); el.type = 'button'; el.dataset.group = 'budget'; el.dataset.val = i;
      el.innerHTML = `<b>M = ${fmt(b.M)}</b><span>${(b.N / 1000).toFixed(1)}K GS</span>`;
      if (b.default) { el.classList.add('is-default'); el.title = 'Default budget for ' + S.V + ' input views'; }
      el.onclick = () => showBudget(i);
      bw.appendChild(el);
    });
  }
  document.querySelectorAll('[data-group="views"]').forEach(el => el.onclick = () => {
    const V = +el.dataset.val; if (V === S.V) return;
    S.V = V; setSegment('views', V); S.budget = null;
    buildScenes(); buildGallery(); showScene(S.sceneIndex);
  });
  document.querySelectorAll('[data-group="show"]').forEach(el => el.onclick = () => {
    S.show = el.dataset.val; setSegment('show', S.show);
    $('colorRow').hidden = !(S.show === 'both' || S.show === 'anchors'); $('countRow').hidden = $('colorRow').hidden;
    $('inspectRow').hidden = S.show === 'gauss';
    if (S.show === 'gauss') select(-1); else updateTarget(true); S.dirty = true;
  });
  document.querySelectorAll('[data-group="color"]').forEach(el => el.onclick = () => {
    S.colorMode = +el.dataset.val; setSegment('color', S.colorMode);
    document.querySelectorAll('.legend').forEach(l => l.hidden = l.dataset.mode !== el.dataset.val);
    S.dirty = true;
  });
  document.querySelectorAll('[data-group="focus"]').forEach(el => el.onclick = () => { S.focus = el.dataset.val; setSegment('focus', S.focus); S.dirty = true; });
  ui.count.oninput = () => { S.growing = false; S.count = +ui.count.value; syncCount(); if (S.sel >= S.count) select(-1); S.dirty = true; };
  $('grow').onclick = () => { if (!S.data) return; select(-1); S.count = 1; S.growing = true; };
  ui.path.oninput = () => { stopPlay(); S.path = +ui.path.value; setCam(pathCam(S.path), S.pathDepth); };
  $('play').onclick = () => { S.playing = !S.playing; S.dir = S.dir || 1; $('play').textContent = S.playing ? 'Pause' : 'Play'; };
  $('overview').onclick = () => { if (!S.data) return; stopPlay(); const o = overviewCam(); setCam(o.cam, o.depth); };
  $('reset').onclick = () => { stopPlay(); S.path = 0; ui.path.value = 0; setCam(inputCams()[0]); };
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= (S.scene ? sv().inputs.length : 0)) { stopPlay(); setCam(inputCams()[n - 1]); }
    if (e.key === 'Escape') select(-1);
  });
  window.addEventListener('resize', () => { S.dirty = true; });

  setSegment('show', S.show); setSegment('color', S.colorMode); setSegment('views', S.V); setSegment('focus', S.focus);
  $('inspectRow').hidden = true; $('focusRow').hidden = true;
  S.sceneIndex = 0; buildScenes(); buildGallery();
  $('colorRow').hidden = true; $('countRow').hidden = true;
  showScene(0);
  requestAnimationFrame(frame);
  window.__suppState = S;   // for automated checks and screenshots
  window.__suppInspect = inspect;
})();
