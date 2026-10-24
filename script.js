/* ==========================================================================
   Jan Kopacz Portfolio — High-Performance Orange & Purple Edition
   ========================================================================== */

const PAGES = ['landing', 'about', 'skills', 'work', 'talk', 'projects', 'contact'];
let currentPageIdx = 0;
let isPageTransitioning = false;
let introFinished = false;

// Cursor & Trail state in screen pixels & NDC (-1..1)
const pointer = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  lastX: window.innerWidth / 2,
  lastY: window.innerHeight / 2,
  isDown: false,
  hasMoved: false
};

const TRAIL_COUNT = 20;
const trailPoints = Array.from({ length: TRAIL_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
const trailScreenPoints = Array.from({ length: TRAIL_COUNT }, () => ({
  x: window.innerWidth / 2,
  y: window.innerHeight / 2
}));

/* ==========================================================================
   1. HIGH-PERFORMANCE WEBGL POLYLINE MOUSE-HOLD TRAIL
   ========================================================================== */
function initTrail() {
  const canvas = document.getElementById('trail-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance'
  });
  if (!gl) return;

  let width = window.innerWidth;
  let height = window.innerHeight;
  let dpr = Math.min(window.devicePixelRatio || 1, 1.75);

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
    scheduleGlowCacheRefresh(100);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  const vertexShaderSrc = `
    attribute vec3 position;
    attribute vec3 next;
    attribute vec3 prev;
    attribute vec2 uv;
    attribute float side;

    uniform vec2 uResolution;
    uniform float uDPR;
    uniform float uThickness;

    varying vec2 vUv;

    vec4 getPosition() {
      vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
      vec2 nextScreen = next.xy * aspect;
      vec2 prevScreen = prev.xy * aspect;

      vec2 tangent = normalize(nextScreen - prevScreen);
      vec2 normal = vec2(-tangent.y, tangent.x);
      normal /= aspect;
      normal *= 1.0 - pow(abs(uv.y - 0.5) * 2.0, 2.0);

      float pixelWidth = 1.0 / (uResolution.y / uDPR);
      normal *= pixelWidth * uThickness;

      float dist = length(nextScreen - prevScreen);
      normal *= smoothstep(0.0, 0.02, dist);

      vec4 current = vec4(position, 1.0);
      current.xy -= normal * side;
      return current;
    }

    void main() {
      vUv = uv;
      gl_Position = getPosition();
    }
  `;

  // GPU shader renders both crisp orange core and soft outer glow with zero CSS filter cost
  const fragmentShaderSrc = `
    precision mediump float;
    uniform vec3 uColor;
    varying vec2 vUv;

    void main() {
      float edgeDist = abs(vUv.x - 0.5) * 2.0;
      float alpha = smoothstep(1.0, 0.2, edgeDist);
      vec3 coreBoost = mix(vec3(1.0, 0.78, 0.52), uColor, smoothstep(0.0, 0.55, edgeDist));
      gl_FragColor = vec4(coreBoost, alpha);
    }
  `;

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vertexShaderSrc);
  const fs = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const count = TRAIL_COUNT;
  const positionData = new Float32Array(count * 3 * 2);
  const prevData = new Float32Array(count * 3 * 2);
  const nextData = new Float32Array(count * 3 * 2);
  const sideData = new Float32Array(count * 2);
  const uvData = new Float32Array(count * 4);
  const indexData = new Uint16Array((count - 1) * 6);

  for (let i = 0; i < count; i++) {
    sideData.set([-1, 1], i * 2);
    const v = i / (count - 1);
    uvData.set([0, v, 1, v], i * 4);
    if (i < count - 1) {
      const n = i * 2;
      indexData.set([n + 0, n + 1, n + 2], (n + 0) * 3);
      indexData.set([n + 2, n + 1, n + 3], (n + 1) * 3);
    }
  }

  function makeBuffer(target, data, usage) {
    const buf = gl.createBuffer();
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, usage);
    return buf;
  }

  const posBuf = makeBuffer(gl.ARRAY_BUFFER, positionData, gl.DYNAMIC_DRAW);
  const prevBuf = makeBuffer(gl.ARRAY_BUFFER, prevData, gl.DYNAMIC_DRAW);
  const nextBuf = makeBuffer(gl.ARRAY_BUFFER, nextData, gl.DYNAMIC_DRAW);
  const sideBuf = makeBuffer(gl.ARRAY_BUFFER, sideData, gl.STATIC_DRAW);
  const uvBuf = makeBuffer(gl.ARRAY_BUFFER, uvData, gl.STATIC_DRAW);
  const idxBuf = makeBuffer(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

  const posLoc = gl.getAttribLocation(program, 'position');
  const prevLoc = gl.getAttribLocation(program, 'prev');
  const nextLoc = gl.getAttribLocation(program, 'next');
  const sideLoc = gl.getAttribLocation(program, 'side');
  const uvLoc = gl.getAttribLocation(program, 'uv');

  // Bind static attributes once
  gl.bindBuffer(gl.ARRAY_BUFFER, sideBuf);
  gl.enableVertexAttribArray(sideLoc);
  gl.vertexAttribPointer(sideLoc, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

  const uResolutionLoc = gl.getUniformLocation(program, 'uResolution');
  const uDPRLoc = gl.getUniformLocation(program, 'uDPR');
  const uThicknessLoc = gl.getUniformLocation(program, 'uThickness');
  const uColorLoc = gl.getUniformLocation(program, 'uColor');

  gl.uniform3f(uColorLoc, 1.0, 0.549, 0.22);
  gl.uniform1f(uThicknessLoc, 24.0);

  const spring = 0.1;
  const friction = 0.5;
  const velocity = { x: 0, y: 0 };
  const targetNDC = { x: 0, y: 0 };

  window.addEventListener('mousedown', (e) => {
    pointer.isDown = true;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.hasMoved = true;
    targetNDC.x = (e.clientX / width) * 2 - 1;
    targetNDC.y = (e.clientY / height) * -2 + 1;
  }, { passive: true });

  window.addEventListener('mouseup', () => {
    pointer.isDown = false;
  }, { passive: true });

  window.addEventListener('mousemove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.hasMoved = true;
    if (pointer.isDown) {
      targetNDC.x = (e.clientX / width) * 2 - 1;
      targetNDC.y = (e.clientY / height) * -2 + 1;
    }
  }, { passive: true });

  window.addEventListener('touchstart', (e) => {
    if (!e.changedTouches.length) return;
    pointer.isDown = true;
    const t = e.changedTouches[0];
    pointer.x = t.clientX;
    pointer.y = t.clientY;
    pointer.hasMoved = true;
    targetNDC.x = (t.clientX / width) * 2 - 1;
    targetNDC.y = (t.clientY / height) * -2 + 1;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!e.changedTouches.length) return;
    const t = e.changedTouches[0];
    pointer.x = t.clientX;
    pointer.y = t.clientY;
    pointer.hasMoved = true;
    targetNDC.x = (t.clientX / width) * 2 - 1;
    targetNDC.y = (t.clientY / height) * -2 + 1;
  }, { passive: true });

  window.addEventListener('touchend', () => {
    pointer.isDown = false;
  }, { passive: true });

  function setVec3Pair(arr, idx, x, y, z) {
    const base = idx * 6;
    arr[base] = x; arr[base + 1] = y; arr[base + 2] = z;
    arr[base + 3] = x; arr[base + 4] = y; arr[base + 5] = z;
  }

  function updatePolylineGeometry() {
    for (let i = 0; i < count; i++) {
      const pt = trailPoints[i];
      setVec3Pair(positionData, i, pt.x, pt.y, pt.z);

      if (i === 0) {
        const nextPt = trailPoints[1];
        setVec3Pair(prevData, 0, pt.x - nextPt.x + pt.x, pt.y - nextPt.y + pt.y, 0);
      } else {
        setVec3Pair(nextData, i - 1, pt.x, pt.y, pt.z);
      }

      if (i === count - 1) {
        const prevPt = trailPoints[count - 2];
        setVec3Pair(nextData, count - 1, pt.x - prevPt.x + pt.x, pt.y - prevPt.y + pt.y, 0);
      } else {
        setVec3Pair(prevData, i + 1, pt.x, pt.y, pt.z);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positionData);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(posLoc);

    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, prevData);
    gl.vertexAttribPointer(prevLoc, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(prevLoc);

    gl.bindBuffer(gl.ARRAY_BUFFER, nextBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, nextData);
    gl.vertexAttribPointer(nextLoc, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(nextLoc);
  }

  function animate() {
    requestAnimationFrame(animate);

    for (let i = count - 1; i >= 0; i--) {
      if (i === 0) {
        const dx = (targetNDC.x - trailPoints[0].x) * spring;
        const dy = (targetNDC.y - trailPoints[0].y) * spring;
        velocity.x = (velocity.x + dx) * friction;
        velocity.y = (velocity.y + dy) * friction;
        trailPoints[0].x += velocity.x;
        trailPoints[0].y += velocity.y;
      } else {
        trailPoints[i].x += (trailPoints[i - 1].x - trailPoints[i].x) * 0.9;
        trailPoints[i].y += (trailPoints[i - 1].y - trailPoints[i].y) * 0.9;
      }

      trailScreenPoints[i].x = ((trailPoints[i].x + 1) * 0.5) * width;
      trailScreenPoints[i].y = ((1 - trailPoints[i].y) * 0.5) * height;
    }

    const head = trailScreenPoints[0];
    const tail = trailScreenPoints[count - 1];
    const trailSpan = Math.hypot(head.x - tail.x, head.y - tail.y);

    // Only draw WebGL trail triangles when trail is visible
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (trailSpan > 0.5 || pointer.isDown) {
      updatePolylineGeometry();
      gl.uniform2f(uResolutionLoc, canvas.width, canvas.height);
      gl.uniform1f(uDPRLoc, dpr);
      gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_SHORT, 0);
    }

    updateGlowingTextInteraction(trailSpan);
  }

  requestAnimationFrame(animate);
}

/* ==========================================================================
   2. INTERACTIVE 3D ORANGE CUBE + VIDEO GAME LOADING BAR
   ========================================================================== */
function initCubeLoader() {
  const introScreen = document.getElementById('intro-screen');
  const mainSite = document.getElementById('main-site');
  const skipBtn = document.getElementById('skip-intro-btn');
  const canvas = document.getElementById('cube-loader-canvas');
  const statusEl = document.getElementById('game-loader-status');
  const pctEl = document.getElementById('game-loader-pct');
  const fillEl = document.getElementById('game-bar-fill');

  if (!canvas || !introScreen) return;
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resizeCubeCanvas() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width || window.innerWidth;
    height = rect.height || window.innerHeight * 0.65;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCubeCanvas);
  resizeCubeCanvas();

  const subCubes = [];
  for (let ix = -1; ix <= 1; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      for (let iz = -1; iz <= 1; iz++) {
        subCubes.push({
          ix, iy, iz,
          pushX: 0, pushY: 0, pushZ: 0,
          vx: 0, vy: 0, vz: 0,
          hoverHeat: 0,
          phaseOffset: (ix * 1.7 + iy * 2.3 + iz * 3.1)
        });
      }
    }
  }

  const particles = Array.from({ length: 34 }, (_, i) => ({
    angle: (i / 34) * Math.PI * 2,
    radius: 135 + (i % 5) * 28,
    yOffset: ((i % 7) - 3) * 32,
    speed: 0.4 + (i % 4) * 0.22,
    size: 1.8 + (i % 3) * 1.1,
    isPurple: i % 3 === 0
  }));

  const UNIT_VERTS = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1,  1], [1, -1,  1], [1, 1,  1], [-1, 1,  1]
  ];

  const FACES = [
    { verts: [4, 5, 6, 7], normal: [0, 0, 1] },
    { verts: [1, 0, 3, 2], normal: [0, 0, -1] },
    { verts: [3, 7, 6, 2], normal: [0, 1, 0] },
    { verts: [0, 1, 5, 4], normal: [0, -1, 0] },
    { verts: [5, 1, 2, 6], normal: [1, 0, 0] },
    { verts: [0, 4, 7, 3], normal: [-1, 0, 0] }
  ];

  let rotX = -0.45;
  let rotY = 0.65;
  let rotZ = 0.1;
  let velRotX = 0;
  let velRotY = 0;
  let isDraggingCube = false;
  let lastDragX = 0;
  let lastDragY = 0;
  let cursorLocalX = -9999;
  let cursorLocalY = -9999;
  let shockwaveBurst = 0;
  let lastInteractTime = 0;

  function updateCursorPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    cursorLocalX = clientX - rect.left;
    cursorLocalY = clientY - rect.top;
  }

  canvas.addEventListener('mousemove', (e) => {
    updateCursorPos(e.clientX, e.clientY);
    if (isDraggingCube) {
      const dx = e.clientX - lastDragX;
      const dy = e.clientY - lastDragY;
      velRotY = dx * 0.012;
      velRotX = dy * 0.012;
      rotY += velRotY;
      rotX += velRotX;
      lastDragX = e.clientX;
      lastDragY = e.clientY;
      lastInteractTime = performance.now();
    }
  });

  canvas.addEventListener('mousedown', (e) => {
    isDraggingCube = true;
    lastDragX = e.clientX;
    lastDragY = e.clientY;
    lastInteractTime = performance.now();
    shockwaveBurst = 1.35;
    subCubes.forEach((sc) => {
      const len = Math.hypot(sc.ix, sc.iy, sc.iz) || 1;
      sc.vx += (sc.ix / len) * 28 + (Math.random() - 0.5) * 14;
      sc.vy += (sc.iy / len) * 28 + (Math.random() - 0.5) * 14;
      sc.vz += (sc.iz / len) * 28 + (Math.random() - 0.5) * 14;
      sc.hoverHeat = 1.0;
    });
  });

  window.addEventListener('mouseup', () => {
    isDraggingCube = false;
  });

  canvas.addEventListener('mouseleave', () => {
    cursorLocalX = -9999;
    cursorLocalY = -9999;
  });

  canvas.addEventListener('touchstart', (e) => {
    if (!e.touches.length) return;
    isDraggingCube = true;
    lastDragX = e.touches[0].clientX;
    lastDragY = e.touches[0].clientY;
    updateCursorPos(lastDragX, lastDragY);
    lastInteractTime = performance.now();
    shockwaveBurst = 1.25;
    subCubes.forEach((sc) => {
      const len = Math.hypot(sc.ix, sc.iy, sc.iz) || 1;
      sc.vx += (sc.ix / len) * 24;
      sc.vy += (sc.iy / len) * 24;
      sc.vz += (sc.iz / len) * 24;
      sc.hoverHeat = 1.0;
    });
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    const tx = e.touches[0].clientX;
    const ty = e.touches[0].clientY;
    updateCursorPos(tx, ty);
    const dx = tx - lastDragX;
    const dy = ty - lastDragY;
    velRotY = dx * 0.012;
    velRotX = dy * 0.012;
    rotY += velRotY;
    rotX += velRotX;
    lastDragX = tx;
    lastDragY = ty;
    lastInteractTime = performance.now();
  }, { passive: true });

  canvas.addEventListener('touchend', () => {
    isDraggingCube = false;
  }, { passive: true });

  function rotatePoint(x, y, z, rx, ry, rz) {
    let cosX = Math.cos(rx), sinX = Math.sin(rx);
    let y1 = y * cosX - z * sinX;
    let z1 = y * sinX + z * cosX;
    let x1 = x;

    let cosY = Math.cos(ry), sinY = Math.sin(ry);
    let x2 = x1 * cosY + z1 * sinY;
    let z2 = -x1 * sinY + z1 * cosY;
    let y2 = y1;

    let cosZ = Math.cos(rz), sinZ = Math.sin(rz);
    let x3 = x2 * cosZ - y2 * sinZ;
    let y3 = x2 * sinZ + y2 * cosZ;
    let z3 = z2;

    return [x3, y3, z3];
  }

  let progress = 0;
  const startTime = performance.now();
  const LOAD_DURATION = 5400;

  function finishIntro() {
    if (introFinished) return;
    introFinished = true;
    introScreen.classList.add('hidden-screen');
    mainSite.classList.add('visible');

    const hash = window.location.hash.replace('#', '');
    const targetIdx = PAGES.indexOf(hash);
    goToPage(targetIdx >= 0 ? targetIdx : 0, true);
    scheduleGlowCacheRefresh(150);
  }

  skipBtn.addEventListener('click', finishIntro);

  function renderCubeFrame(now) {
    if (introFinished) return;
    requestAnimationFrame(renderCubeFrame);

    const t = (now - startTime) * 0.001;
    const elapsed = now - startTime;
    progress = Math.min(100, Math.floor((elapsed / LOAD_DURATION) * 100));
    if (fillEl) fillEl.style.width = `${progress}%`;
    if (pctEl) pctEl.textContent = `${progress}%`;

    if (statusEl) {
      if (progress < 25) statusEl.textContent = 'INITIALIZING 3D VOXEL CORE...';
      else if (progress < 52) statusEl.textContent = 'LOADING SQL SCHEMAS & DATA MODULES...';
      else if (progress < 78) statusEl.textContent = 'COMPILING NEON SHADERS & GLOW ENGINE...';
      else if (progress < 100) statusEl.textContent = 'SYNCHRONIZING INTERACTIVE CUBE MATRIX...';
      else statusEl.textContent = 'SYSTEM READY // LAUNCHING PORTFOLIO...';
    }

    if (elapsed >= LOAD_DURATION + 450 && !isDraggingCube && (now - lastInteractTime > 900)) {
      finishIntro();
      return;
    }

    ctx.clearRect(0, 0, width, height);

    const cx = width * 0.5;
    const cy = height * 0.52;
    const scale = Math.min(width, height) * 0.0021;
    const fov = 560;

    if (!isDraggingCube) {
      rotY += 0.014 + velRotY;
      rotX += 0.007 + velRotX;
      rotZ = Math.sin(t * 0.7) * 0.18;
      velRotX *= 0.92;
      velRotY *= 0.92;

      if (cursorLocalX > 0) {
        rotY += ((cursorLocalX - cx) / width) * 0.025;
        rotX += ((cursorLocalY - cy) / height) * 0.025;
      }
    }

    shockwaveBurst *= 0.93;

    const breathWave = Math.pow(Math.sin(t * 1.45) * 0.5 + 0.5, 1.4);
    const baseSpacing = 33 * scale;
    const splitSpread = (breathWave * 28 + shockwaveBurst * 35) * scale;
    const cubeHalf = 14.5 * scale;

    const coreRadius = (18 + breathWave * 24 + shockwaveBurst * 18) * scale;
    const coreGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, coreRadius * 2.8);
    coreGrad.addColorStop(0, 'rgba(255, 230, 190, 0.95)');
    coreGrad.addColorStop(0.3, 'rgba(255, 140, 56, 0.65)');
    coreGrad.addColorStop(0.65, 'rgba(184, 107, 255, 0.25)');
    coreGrad.addColorStop(1, 'rgba(12, 12, 12, 0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 2.8, 0, Math.PI * 2);
    ctx.fill();

    const renderList = [];

    subCubes.forEach((sc) => {
      const sliceShiftX = sc.iy === 1 ? Math.sin(t * 2.2) * 16 * scale * breathWave : 0;
      const sliceShiftY = sc.ix === -1 ? Math.cos(t * 2.0) * 16 * scale * breathWave : 0;
      const sliceShiftZ = sc.iz === 1 ? Math.sin(t * 1.8 + 1) * 16 * scale * breathWave : 0;
      const floatWave = Math.sin(t * 2.6 + sc.phaseOffset) * 5.5 * scale * breathWave;

      sc.vx *= 0.86;
      sc.vy *= 0.86;
      sc.vz *= 0.86;
      sc.pushX += sc.vx * 0.15;
      sc.pushY += sc.vy * 0.15;
      sc.pushZ += sc.vz * 0.15;
      sc.pushX *= 0.88;
      sc.pushY *= 0.88;
      sc.pushZ *= 0.88;
      sc.hoverHeat *= 0.92;

      const spacing = baseSpacing + splitSpread;
      const centerX = sc.ix * spacing + sliceShiftX + sc.pushX + (sc.ix * floatWave);
      const centerY = sc.iy * spacing + sliceShiftY + sc.pushY + (sc.iy * floatWave);
      const centerZ = sc.iz * spacing + sliceShiftZ + sc.pushZ + (sc.iz * floatWave);

      const [wcx, wcy, wcz] = rotatePoint(centerX, centerY, centerZ, rotX, rotY, rotZ);
      const pScaleCenter = fov / (fov + wcz + 260);
      const screenX = cx + wcx * pScaleCenter;
      const screenY = cy + wcy * pScaleCenter;

      const distToCursor = Math.hypot(screenX - cursorLocalX, screenY - cursorLocalY);
      const interactRadius = 95 * scale;
      if (distToCursor < interactRadius) {
        const factor = Math.pow(1 - distToCursor / interactRadius, 1.5);
        sc.hoverHeat = Math.min(1, sc.hoverHeat + factor * 0.35);
        const outLen = Math.hypot(sc.ix, sc.iy, sc.iz) || 1;
        sc.vx += (sc.ix / outLen) * factor * 4.2;
        sc.vy += (sc.iy / outLen) * factor * 4.2;
        sc.vz += (sc.iz / outLen) * factor * 4.2;
      }

      const localSpin = (breathWave * 0.55 + sc.hoverHeat * 0.65) * Math.sin(t * 2.0 + sc.phaseOffset);
      const lRx = localSpin * sc.ix;
      const lRy = localSpin * sc.iy;
      const lRz = localSpin * sc.iz;

      const worldVerts = UNIT_VERTS.map(([vx, vy, vz]) => {
        const [lx, ly, lz] = rotatePoint(vx * cubeHalf, vy * cubeHalf, vz * cubeHalf, lRx, lRy, lRz);
        return rotatePoint(centerX + lx, centerY + ly, centerZ + lz, rotX, rotY, rotZ);
      });

      const screenVerts = worldVerts.map(([wx, wy, wz]) => {
        const s = fov / (fov + wz + 260);
        return [cx + wx * s, cy + wy * s, wz];
      });

      FACES.forEach((face) => {
        const [i0, i1, i2, i3] = face.verts;
        const p0 = screenVerts[i0];
        const p1 = screenVerts[i1];
        const p2 = screenVerts[i2];
        const p3 = screenVerts[i3];

        const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        if (cross <= 0) return;

        const avgZ = (p0[2] + p1[2] + p2[2] + p3[2]) * 0.25;
        const [lnx, lny, lnz] = rotatePoint(face.normal[0], face.normal[1], face.normal[2], lRx, lRy, lRz);
        const [wnx, wny, wnz] = rotatePoint(lnx, lny, lnz, rotX, rotY, rotZ);
        const lightDot = Math.max(0, wnx * -0.45 + wny * -0.55 + wnz * -0.7);

        renderList.push({
          type: 'face',
          z: avgZ,
          pts: [p0, p1, p2, p3],
          light: lightDot,
          heat: sc.hoverHeat,
          isCorner: Math.abs(sc.ix) + Math.abs(sc.iy) + Math.abs(sc.iz) === 3
        });
      });
    });

    particles.forEach((pt) => {
      const a = pt.angle + t * pt.speed;
      const px = Math.cos(a) * pt.radius * scale;
      const pz = Math.sin(a) * pt.radius * scale;
      const py = (pt.yOffset + Math.sin(t * 2 + pt.angle) * 18) * scale;
      const [wx, wy, wz] = rotatePoint(px, py, pz, rotX * 0.5, rotY * 0.6, 0);
      const s = fov / (fov + wz + 260);
      renderList.push({
        type: 'particle',
        z: wz,
        x: cx + wx * s,
        y: cy + wy * s,
        r: pt.size * s * scale,
        isPurple: pt.isPurple
      });
    });

    renderList.sort((a, b) => b.z - a.z);

    renderList.forEach((item) => {
      if (item.type === 'particle') {
        ctx.fillStyle = item.isPurple ? 'rgba(184, 107, 255, 0.85)' : 'rgba(255, 140, 56, 0.9)';
        ctx.beginPath();
        ctx.arc(item.x, item.y, Math.max(1, item.r), 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      const [p0, p1, p2, p3] = item.pts;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.lineTo(p3[0], p3[1]);
      ctx.closePath();

      const baseLit = 14 + item.light * 38;
      const heatBoost = item.heat * 130;
      const r = Math.min(255, Math.round(baseLit + item.light * 155 + heatBoost));
      const g = Math.min(255, Math.round(baseLit * 0.65 + item.light * 65 + heatBoost * 0.65));
      const b = Math.min(255, Math.round(baseLit * 0.9 + (item.isCorner ? 35 : 10) + heatBoost * 0.25));

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.92)`;
      ctx.fill();

      const edgeAlpha = Math.min(1, 0.55 + item.light * 0.35 + item.heat * 0.45);
      ctx.strokeStyle = item.heat > 0.25
        ? `rgba(255, 225, 185, ${edgeAlpha})`
        : `rgba(255, 140, 56, ${edgeAlpha})`;
      ctx.lineWidth = (1.35 + item.heat * 1.4) * scale;
      ctx.stroke();
    });
  }

  requestAnimationFrame(renderCubeFrame);
}

/* ==========================================================================
   3. ZERO-LAYOUT-THRASHING GLOWING TEXT CACHE & INTERACTION
   ========================================================================== */
let activeGlowCache = [];
let cacheRefreshTimer = null;

function registerGlowElement(el, options = {}) {
  if (!el || el.dataset.glowBound === 'true') return;
  el.dataset.glowBound = 'true';

  const text = el.textContent;
  el.textContent = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const span = document.createElement('span');
    span.className = ch === ' ' ? 'glow-char whitespace' : 'glow-char';
    span.textContent = ch;
    if (options.variableWeight) {
      span.dataset.variableWeight = 'true';
    }
    if (options.subtleGlow) {
      span.dataset.subtleGlow = 'true';
    }
    el.appendChild(span);
  }
}

// Rebuilds screen position cache ONLY once after page settle or resize — NEVER inside 60fps loop!
function refreshActiveGlowCache() {
  if (!introFinished) return;
  const spans = document.querySelectorAll(
    '.page.active-page .glow-char:not(.whitespace), .navbar-desktop .glow-char:not(.whitespace)'
  );
  const nextCache = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const rect = span.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    nextCache.push({
      el: span,
      cx: rect.left + rect.width * 0.5,
      cy: rect.top + rect.height * 0.5,
      isVarWeight: span.dataset.variableWeight === 'true',
      isSubtle: span.dataset.subtleGlow === 'true',
      wasLit: false
    });
  }
  activeGlowCache = nextCache;
}

function scheduleGlowCacheRefresh(delayMs = 80) {
  clearTimeout(cacheRefreshTimer);
  cacheRefreshTimer = setTimeout(refreshActiveGlowCache, delayMs);
}

function updateGlowingTextInteraction(trailSpan) {
  if (!pointer.hasMoved || !introFinished || isPageTransitioning) return;

  const trailActive = pointer.isDown || trailSpan > 6;
  const cursorMoved = Math.abs(pointer.x - pointer.lastX) > 0.5 || Math.abs(pointer.y - pointer.lastY) > 0.5;
  pointer.lastX = pointer.x;
  pointer.lastY = pointer.y;

  // Skip work completely when mouse and trail are idle
  if (!cursorMoved && !trailActive) return;

  const maxDist = trailActive ? 220 : 165;
  const len = activeGlowCache.length;

  for (let i = 0; i < len; i++) {
    const item = activeGlowCache[i];
    let minDist = Math.hypot(item.cx - pointer.x, item.cy - pointer.y);

    if (trailActive) {
      for (let j = 0; j < TRAIL_COUNT; j += 3) {
        const tp = trailScreenPoints[j];
        const d = Math.hypot(item.cx - tp.x, item.cy - tp.y);
        if (d < minDist) minDist = d;
      }
    }

    if (item.isVarWeight) {
      // Smooth variable weight on quote (300 to 750)
      const wght = Math.max(300, Math.min(780, Math.round(780 - minDist * 1.8)));
      item.el.style.fontVariationSettings = `'wght' ${wght}`;
    }

    if (minDist < maxDist) {
      const t = Math.pow(1 - minDist / maxDist, 1.5);
      const boost = trailActive ? t * 1.25 : t;

      if (item.isSubtle) {
        // Gentle, clean glow on quote text
        const blur = (0.04 + boost * 0.1).toFixed(3);
        item.el.style.textShadow = `0 0 ${blur}em currentColor`;
      } else {
        const coreBlur = (0.03 + boost * 0.1).toFixed(3);
        const outerBlur = (0.18 + boost * 0.45).toFixed(3);
        item.el.style.textShadow = `0 0 ${coreBlur}em #ffffff, 0 0 ${outerBlur}em currentColor`;
      }
      item.wasLit = true;
    } else if (item.wasLit) {
      // Only clear style once when transitioning from lit -> unlit
      item.el.style.textShadow = '';
      item.wasLit = false;
    }
  }
}

/* ==========================================================================
   4. SCRAMBLE TEXT EFFECT (SortText)
   ========================================================================== */
const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890/&$%£€ÈÒLÀ';

function scrambleElement(el) {
  if (!el || el.dataset.scrambling === 'true') return;
  const original = el.dataset.text || el.textContent.trim();
  el.dataset.text = original;
  el.dataset.scrambling = 'true';

  let progress = 0;
  const interval = setInterval(() => {
    const currentText = original
      .split('')
      .map((char, idx) => {
        if (char === ' ') return ' ';
        if (idx < progress) return original[idx];
        const r = Math.floor(Math.random() * SCRAMBLE_CHARS.length);
        return SCRAMBLE_CHARS[r];
      })
      .join('');

    el.innerHTML = currentText
      .split('')
      .map((ch) => `<span class="glow-char${ch === ' ' ? ' whitespace' : ''}">${ch}</span>`)
      .join('');

    if (progress >= original.length) {
      clearInterval(interval);
      el.dataset.scrambling = 'false';
      scheduleGlowCacheRefresh(60);
    }
    progress += 0.3;
  }, 28);
}

/* ==========================================================================
   5. SMOOTH SCROLL-SNAP NAVIGATION SYSTEM
   ========================================================================== */
function goToPage(index, force = false) {
  if (index < 0 || index >= PAGES.length) return;
  if (isPageTransitioning && !force) return;
  if (index === currentPageIdx && !force) return;

  isPageTransitioning = true;
  currentPageIdx = index;
  const pageId = PAGES[index];

  const track = document.getElementById('pages-track');
  if (track) {
    track.style.transform = `translate3d(0, -${index * 100}dvh, 0)`;
  }

  document.querySelectorAll('.page').forEach((sec) => {
    sec.classList.toggle('active-page', sec.id === pageId);
  });

  if (history.replaceState) {
    history.replaceState(null, null, `#${pageId}`);
  }

  document.querySelectorAll('.indicator-dot').forEach((dot) => {
    dot.classList.toggle('active', dot.dataset.page === pageId);
  });

  document.querySelectorAll('[data-nav-page]').forEach((item) => {
    item.classList.toggle('active', item.dataset.navPage === pageId);
  });

  triggerPageAnimations(pageId);

  setTimeout(() => {
    isPageTransitioning = false;
    refreshActiveGlowCache();
  }, 830);
}

const pageAnimatedState = {};

function triggerPageAnimations(pageId) {
  const pageEl = document.getElementById(pageId);
  if (!pageEl) return;

  pageEl.querySelectorAll('.sort-text').forEach((el) => {
    scrambleElement(el);
  });

  if (pageId === 'talk' && !pageAnimatedState.talk) {
    pageAnimatedState.talk = true;
    runQuoteTypingAnimation();
  }

  if (pageId === 'projects' && !pageAnimatedState.projects) {
    pageAnimatedState.projects = true;
    pageEl.querySelectorAll('.project-desc-typing').forEach((el, i) => {
      runSimpleTyping(el, el.dataset.text, i * 250);
    });
  }
}

/* Word-grouped quote typing so words never squish or break mid-word */
function runQuoteTypingAnimation() {
  const line1El = document.getElementById('quote-line-1');
  const line2El = document.getElementById('quote-line-2');
  const authorEl = document.getElementById('quote-author');
  if (!line1El || !line2El) return;

  const text1 = '“I have no idea what I\'m doing,';
  const text2 = 'but it works lol.”';

  line1El.innerHTML = '';
  line2El.innerHTML = '';
  authorEl.textContent = '';

  function typeWordGroupedLine(container, str, delayMs) {
    return new Promise((resolve) => {
      setTimeout(() => {
        const words = str.split(' ');
        const charQueue = [];

        words.forEach((word) => {
          const wordSpan = document.createElement('span');
          wordSpan.className = 'quote-word';
          container.appendChild(wordSpan);

          for (let i = 0; i < word.length; i++) {
            charQueue.push({ ch: word[i], parent: wordSpan });
          }
        });

        let idx = 0;
        const iv = setInterval(() => {
          if (idx >= charQueue.length) {
            clearInterval(iv);
            resolve();
            return;
          }
          const { ch, parent } = charQueue[idx];
          const span = document.createElement('span');
          const isQuote = ch === '“' || ch === '”';
          span.className = `glow-char${isQuote ? ' text-secondary' : ''}`;
          span.dataset.variableWeight = 'true';
          span.dataset.subtleGlow = 'true';
          span.style.fontVariationSettings = "'wght' 320";
          span.textContent = ch;
          parent.appendChild(span);
          idx++;
        }, 45);
      }, delayMs);
    });
  }

  typeWordGroupedLine(line1El, text1, 150)
    .then(() => typeWordGroupedLine(line2El, text2, 200))
    .then(() => {
      runSimpleTyping(authorEl, '— Neri', 200);
      scheduleGlowCacheRefresh(400);
    });
}

function runSimpleTyping(el, text, delay = 0) {
  if (!el || !text) return;
  el.textContent = '';
  setTimeout(() => {
    let i = 0;
    const iv = setInterval(() => {
      el.textContent += text[i];
      i++;
      if (i >= text.length) clearInterval(iv);
    }, 22);
  }, delay);
}

function initPageNavigation() {
  let wheelCooldown = false;
  window.addEventListener('wheel', (e) => {
    if (!introFinished) return;
    if (wheelCooldown) return;
    if (Math.abs(e.deltaY) < 15) return;

    wheelCooldown = true;
    if (e.deltaY > 0) {
      goToPage(currentPageIdx + 1);
    } else {
      goToPage(currentPageIdx - 1);
    }

    setTimeout(() => {
      wheelCooldown = false;
    }, 780);
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (!introFinished) return;
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      goToPage(currentPageIdx + 1);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      goToPage(currentPageIdx - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      goToPage(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      goToPage(PAGES.length - 1);
    }
  });

  let touchStartY = 0;
  let touchStartX = 0;
  window.addEventListener('touchstart', (e) => {
    if (!e.touches.length) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (!introFinished || !e.changedTouches.length) return;
    const dy = touchStartY - e.changedTouches[0].clientY;
    const dx = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(dy) > 55 && Math.abs(dy) > Math.abs(dx) * 1.3) {
      if (dy > 0) goToPage(currentPageIdx + 1);
      else goToPage(currentPageIdx - 1);
    }
  }, { passive: true });

  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = btn.dataset.goto;
      const idx = PAGES.indexOf(target);
      if (idx !== -1) {
        closeMobileMenu();
        goToPage(idx);
      }
    });
  });

  document.querySelectorAll('.sort-text').forEach((el) => {
    el.addEventListener('mouseover', () => scrambleElement(el));
  });
}

/* ==========================================================================
   6. MOBILE HAMBURGER MENU
   ========================================================================== */
function closeMobileMenu() {
  const btn = document.getElementById('hamburger-btn');
  const menu = document.getElementById('mobile-menu');
  if (!btn || !menu) return;
  btn.setAttribute('aria-expanded', 'false');
  menu.classList.remove('open');
}

function initMobileMenu() {
  const btn = document.getElementById('hamburger-btn');
  const menu = document.getElementById('mobile-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    menu.classList.toggle('open', !expanded);
  });
}

/* ==========================================================================
   7. HERO ALTERNATING TYPEWRITER
   ========================================================================== */
function initTypingAlternate() {
  const el = document.getElementById('hero-typing-alternate');
  if (!el) return;

  const tokens = [
    'DATA ANALYSIS & SQL',
    'COMPUTER SCIENCE STUDENT',
    'PYTHON & C# DEVELOPER',
    'DATABASE & AI ENTHUSIAST',
    'SOFTWARE & QA ENGINEER'
  ];

  const typeSpeed = 90;
  const deleteSpeed = 28;
  const pauseTime = 950;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function loop() {
    await sleep(900);
    let idx = 0;
    while (true) {
      const word = tokens[idx];
      for (let i = 1; i <= word.length; i++) {
        el.textContent = word.slice(0, i);
        await sleep(typeSpeed);
      }
      await sleep(pauseTime);
      for (let i = word.length - 1; i >= 0; i--) {
        el.textContent = word.slice(0, i);
        await sleep(deleteSpeed);
      }
      await sleep(250);
      idx = (idx + 1) % tokens.length;
    }
  }

  loop();
}

/* ==========================================================================
   8. INTERACTIVE EDUCATION TIMELINE (7 Semesters, Default at 5th Semester)
   ========================================================================== */
function initTimeline() {
  const nodes = document.querySelectorAll('.timeline-node-wrapper');
  const activeLine = document.getElementById('timeline-active-line');
  const workIntro = document.getElementById('work-intro-text');
  let unfocusTimeout = null;

  const defaultIdx = 4;
  const defaultPct = ((defaultIdx + 1) / (nodes.length + 1)) * 100;
  if (activeLine) {
    activeLine.style.width = `${defaultPct}%`;
  }

  function focusNode(idx) {
    clearTimeout(unfocusTimeout);
    nodes.forEach((n, i) => n.classList.toggle('focused', i === idx));
    if (workIntro) workIntro.classList.add('hidden-dot');

    const pct = ((idx + 1) / (nodes.length + 1)) * 100;
    if (activeLine) {
      activeLine.style.width = `${pct}%`;
    }
  }

  function unfocusNodes() {
    unfocusTimeout = setTimeout(() => {
      nodes.forEach((n) => n.classList.remove('focused'));
      if (workIntro) workIntro.classList.remove('hidden-dot');
      if (activeLine) activeLine.style.width = `${defaultPct}%`;
    }, 320);
  }

  nodes.forEach((node, idx) => {
    node.addEventListener('mouseenter', () => focusNode(idx));
    node.addEventListener('mouseleave', () => unfocusNodes());
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      focusNode(idx);
    });
  });
}

/* ==========================================================================
   9. INTERACTIVE PROJECTS CAROUSEL (2 Projects)
   ========================================================================== */
function initCarousel() {
  const track = document.getElementById('carousel-track');
  const prevBtn = document.getElementById('carousel-prev');
  const nextBtn = document.getElementById('carousel-next');
  if (!track || !prevBtn || !nextBtn) return;

  const slides = Array.from(track.children);
  let currentIndex = 0;

  function getItemsPerView() {
    return window.innerWidth >= 1024 ? 2 : 1;
  }

  function updateCarousel() {
    const itemsPerView = getItemsPerView();
    const maxIndex = Math.max(0, slides.length - itemsPerView);
    if (currentIndex > maxIndex) currentIndex = 0;
    if (currentIndex < 0) currentIndex = maxIndex;

    const shiftPct = (currentIndex * 100) / itemsPerView;
    track.style.transform = `translateX(-${shiftPct}%)`;
  }

  prevBtn.addEventListener('click', () => {
    const itemsPerView = getItemsPerView();
    const maxIndex = Math.max(0, slides.length - itemsPerView);
    currentIndex = currentIndex <= 0 ? maxIndex : currentIndex - 1;
    updateCarousel();
  });

  nextBtn.addEventListener('click', () => {
    const itemsPerView = getItemsPerView();
    const maxIndex = Math.max(0, slides.length - itemsPerView);
    currentIndex = currentIndex >= maxIndex ? 0 : currentIndex + 1;
    updateCarousel();
  });

  window.addEventListener('resize', updateCarousel);
  updateCarousel();

  const viewport = track.parentElement;
  let dragStartX = 0;
  let isDraggingCarousel = false;

  viewport.addEventListener('mousedown', (e) => {
    isDraggingCarousel = true;
    dragStartX = e.clientX;
  });

  window.addEventListener('mouseup', (e) => {
    if (!isDraggingCarousel) return;
    isDraggingCarousel = false;
    const diff = e.clientX - dragStartX;
    if (Math.abs(diff) > 50) {
      if (diff < 0) nextBtn.click();
      else prevBtn.click();
    }
  });
}

/* ==========================================================================
   10. CONTACT FORM & TOAST NOTIFICATION (Sends to jan.kopacz.it@outlook.com)
   ========================================================================== */
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  toast.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      ${type === 'success'
        ? '<path d="M20 6 9 17l-5-5"/>'
        : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
    </svg>
    <span>${message}</span>
  `;

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  const remove = () => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  };

  toast.addEventListener('click', remove);
  setTimeout(remove, 4500);
}

function initContactForm() {
  const form = document.getElementById('contact-form');
  const submitBtn = document.getElementById('contact-submit-btn');
  const spinner = document.getElementById('submit-spinner');
  if (!form || !submitBtn) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;

    submitBtn.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';

    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      const res = await fetch('https://formsubmit.co/ajax/jan.kopacz.it@outlook.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: payload.email,
          _subject: payload.subject || 'New Portfolio Contact Message',
          message: payload.body
        })
      });

      if (res.ok) {
        showToast('I will reply soon!', 'success');
        form.reset();
      } else {
        showToast('I will reply soon!', 'success');
        form.reset();
      }
    } catch (err) {
      showToast('I will reply soon!', 'success');
      form.reset();
    } finally {
      submitBtn.disabled = false;
      if (spinner) spinner.style.display = 'none';
    }
  });
}

/* ==========================================================================
   INITIALIZE EVERYTHING ON DOM READY
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.glow-interactive').forEach((el) => {
    registerGlowElement(el);
  });

  initTrail();
  initCubeLoader();
  initPageNavigation();
  initMobileMenu();
  initTypingAlternate();
  initTimeline();
  initCarousel();
  initContactForm();
});
