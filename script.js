/* ==========================================================================
   Jan Kopacz Portfolio — Orange & Purple Edition
   ========================================================================== */

const PAGES = ['landing', 'about', 'skills', 'work', 'talk', 'projects', 'contact'];
let currentPageIdx = 0;
let isPageTransitioning = false;
let introFinished = false;

// Cursor & Trail state in screen pixels & NDC (-1..1)
const pointer = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  ndcX: 0,
  ndcY: 0,
  isDown: false,
  hasMoved: false
};

// 20 trail points in NDC (-1..1) and screen pixels
const TRAIL_COUNT = 20;
const trailPoints = Array.from({ length: TRAIL_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
const trailScreenPoints = Array.from({ length: TRAIL_COUNT }, () => ({
  x: window.innerWidth / 2,
  y: window.innerHeight / 2
}));

/* ==========================================================================
   1. WEBGL POLYLINE MOUSE-HOLD TRAIL (Exact ddaniel.dev OGL Shader & Physics)
   ========================================================================== */
function initTrail() {
  const canvas = document.getElementById('trail-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return;

  let width = window.innerWidth;
  let height = window.innerHeight;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize, false);
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
      gl_Position = getPosition();
    }
  `;

  const fragmentShaderSrc = `
    precision highp float;
    uniform vec3 uColor;
    void main() {
      gl_FragColor = vec4(uColor, 1.0);
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

  function bindAttrib(buf, name, size) {
    const loc = gl.getAttribLocation(program, name);
    if (loc === -1) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  const uResolutionLoc = gl.getUniformLocation(program, 'uResolution');
  const uDPRLoc = gl.getUniformLocation(program, 'uDPR');
  const uThicknessLoc = gl.getUniformLocation(program, 'uThickness');
  const uColorLoc = gl.getUniformLocation(program, 'uColor');

  // Neon Orange (#ff8c38)
  gl.uniform3f(uColorLoc, 1.0, 0.549, 0.22);
  gl.uniform1f(uThicknessLoc, 22.0);

  const spring = 0.1;
  const friction = 0.5;
  const velocity = { x: 0, y: 0 };
  const targetNDC = { x: 0, y: 0 };

  function updateTargetFromEvent(e) {
    let clientX, clientY;
    if (e.changedTouches && e.changedTouches.length) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    pointer.x = clientX;
    pointer.y = clientY;
    pointer.hasMoved = true;

    if (pointer.isDown || ('ontouchstart' in window)) {
      targetNDC.x = (clientX / width) * 2 - 1;
      targetNDC.y = (clientY / height) * -2 + 1;
    }
  }

  window.addEventListener('mousedown', (e) => {
    pointer.isDown = true;
    targetNDC.x = (e.clientX / width) * 2 - 1;
    targetNDC.y = (e.clientY / height) * -2 + 1;
  });

  window.addEventListener('mouseup', () => {
    pointer.isDown = false;
  });

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
    pointer.isDown = true;
    updateTargetFromEvent(e);
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    updateTargetFromEvent(e);
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
        const px = pt.x - nextPt.x + pt.x;
        const py = pt.y - nextPt.y + pt.y;
        setVec3Pair(prevData, 0, px, py, 0);
      } else {
        setVec3Pair(nextData, i - 1, pt.x, pt.y, pt.z);
      }

      if (i === count - 1) {
        const prevPt = trailPoints[count - 2];
        const nx = pt.x - prevPt.x + pt.x;
        const ny = pt.y - prevPt.y + pt.y;
        setVec3Pair(nextData, count - 1, nx, ny, 0);
      } else {
        setVec3Pair(prevData, i + 1, pt.x, pt.y, pt.z);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positionData);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, prevData);
    gl.bindBuffer(gl.ARRAY_BUFFER, nextBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, nextData);
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

    updatePolylineGeometry();

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.uniform2f(uResolutionLoc, canvas.width, canvas.height);
    gl.uniform1f(uDPRLoc, dpr);

    bindAttrib(posBuf, 'position', 3);
    bindAttrib(prevBuf, 'prev', 3);
    bindAttrib(nextBuf, 'next', 3);
    bindAttrib(sideBuf, 'side', 1);
    bindAttrib(uvBuf, 'uv', 2);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.TRIANGLES, indexData.length, gl.UNSIGNED_SHORT, 0);

    updateGlowingTextInteraction();
  }

  requestAnimationFrame(animate);
}

/* ==========================================================================
   2. INTERACTIVE 3D ORANGE CUBE (27 Sub-Cubes Splitting, Shifting, Spinning)
      + VIDEO GAME LOADING BAR
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

  // Build 3x3x3 = 27 sub-cubes
  const subCubes = [];
  for (let ix = -1; ix <= 1; ix++) {
    for (let iy = -1; iy <= 1; iy++) {
      for (let iz = -1; iz <= 1; iz++) {
        subCubes.push({
          ix, iy, iz,
          // Dynamic offsets for cursor push & shockwave
          pushX: 0, pushY: 0, pushZ: 0,
          vx: 0, vy: 0, vz: 0,
          hoverHeat: 0,
          phaseOffset: (ix * 1.7 + iy * 2.3 + iz * 3.1)
        });
      }
    }
  }

  // Orbiting glowing energy particles around the cube
  const particles = Array.from({ length: 38 }, (_, i) => ({
    angle: (i / 38) * Math.PI * 2,
    radius: 135 + (i % 5) * 28,
    yOffset: ((i % 7) - 3) * 32,
    speed: 0.4 + (i % 4) * 0.22,
    size: 1.8 + (i % 3) * 1.1,
    isPurple: i % 3 === 0
  }));

  // 8 vertices of a unit cube (-0.5..0.5)
  const UNIT_VERTS = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1,  1], [1, -1,  1], [1, 1,  1], [-1, 1,  1]
  ];

  // 6 faces (vertex indices in counter-clockwise winding)
  const FACES = [
    { verts: [4, 5, 6, 7], normal: [0, 0, 1] },   // Front
    { verts: [1, 0, 3, 2], normal: [0, 0, -1] },  // Back
    { verts: [3, 7, 6, 2], normal: [0, 1, 0] },   // Top
    { verts: [0, 1, 5, 4], normal: [0, -1, 0] },  // Bottom
    { verts: [5, 1, 2, 6], normal: [1, 0, 0] },   // Right
    { verts: [0, 4, 7, 3], normal: [-1, 0, 0] }   // Left
  ];

  // Cube rotation & cursor interaction state
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
    updateCursorPos(e.clientX, 
    e.clientY);
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
    // Trigger shockwave split burst on click!
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

  // 3D Rotation helpers
  function rotatePoint(x, y, z, rx, ry, rz) {
    // Rotate around X
    let cosX = Math.cos(rx), sinX = Math.sin(rx);
    let y1 = y * cosX - z * sinX;
    let z1 = y * sinX + z * cosX;
    let x1 = x;

    // Rotate around Y
    let cosY = Math.cos(ry), sinY = Math.sin(ry);
    let x2 = x1 * cosY + z1 * sinY;
    let z2 = -x1 * sinY + z1 * cosY;
    let y2 = y1;

    // Rotate around Z
    let cosZ = Math.cos(rz), sinZ = Math.sin(rz);
    let x3 = x2 * cosZ - y2 * sinZ;
    let y3 = x2 * sinZ + y2 * cosZ;
    let z3 = z2;

    return [x3, y3, z3];
  }

  // Video Game Loading Bar Progression
  let progress = 0;
  const startTime = performance.now();
  const LOAD_DURATION = 5600; // 5.6 seconds

  function finishIntro() {
    if (introFinished) return;
    introFinished = true;
    introScreen.classList.add('hidden-screen');
    mainSite.classList.add('visible');

    const hash = window.location.hash.replace('#', '');
    const targetIdx = PAGES.indexOf(hash);
    goToPage(targetIdx >= 0 ? targetIdx : 0, true);
  }

  skipBtn.addEventListener('click', finishIntro);

  function renderCubeFrame(now) {
    if (introFinished) return;
    requestAnimationFrame(renderCubeFrame);

    const t = (now - startTime) * 0.001;

    // Update loading bar
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

    // Complete intro once 100% is reached (wait slightly if user is actively dragging)
    if (elapsed >= LOAD_DURATION + 450 && !isDraggingCube && (now - lastInteractTime > 900)) {
      finishIntro();
      return;
    }

    ctx.clearRect(0, 0, width, height);

    const cx = width * 0.5;
    const cy = height * 0.52;
    const scale = Math.min(width, height) * 0.0021;
    const fov = 560;

    // Auto-spin + inertia + subtle cursor tilt
    if (!isDraggingCube) {
      rotY += 0.014 + velRotY;
      rotX += 0.007 + velRotX;
      rotZ = Math.sin(t * 0.7) * 0.18;
      velRotX *= 0.92;
      velRotY *= 0.92;

      if (cursorLocalX > 0) {
        const targetTiltY = ((cursorLocalX - cx) / width) * 0.025;
        const targetTiltX = ((cursorLocalY - cy) / height) * 0.025;
        rotY += targetTiltY;
        rotX += targetTiltX;
      }
    }

    shockwaveBurst *= 0.93;

    // Choreographed Splitting, Shifting & Twisting Cycle
    // Alternates smoothly between unified cube, exploded 27-part split, and sliding slices
    const breathWave = Math.pow(Math.sin(t * 1.45) * 0.5 + 0.5, 1.4);
    const baseSpacing = 33 * scale;
    const splitSpread = (breathWave * 28 + shockwaveBurst * 35) * scale;
    const cubeHalf = 14.5 * scale;

    // Central glowing energy core (visible when sub-cubes split apart)
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

    // Collect all drawable 3D faces across all 27 sub-cubes
    const renderList = [];

    subCubes.forEach((sc) => {
      // Slice-shifting wave: layers slide & twist along axes
      const sliceShiftX = sc.iy === 1 ? Math.sin(t * 2.2) * 16 * scale * breathWave : 0;
      const sliceShiftY = sc.ix === -1 ? Math.cos(t * 2.0) * 16 * scale * breathWave : 0;
      const sliceShiftZ = sc.iz === 1 ? Math.sin(t * 1.8 + 1) * 16 * scale * breathWave : 0;

      // Individual sub-cube floating wave
      const floatWave = Math.sin(t * 2.6 + sc.phaseOffset) * 5.5 * scale * breathWave;

      // Spring physics for interactive push
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
      let centerX = sc.ix * spacing + sliceShiftX + sc.pushX + (sc.ix * floatWave);
      let centerY = sc.iy * spacing + sliceShiftY + sc.pushY + (sc.iy * floatWave);
      let centerZ = sc.iz * spacing + sliceShiftZ + sc.pushZ + (sc.iz * floatWave);

      // Rotate sub-cube center in world space to check cursor proximity in 2D
      const [wcx, wcy, wcz] = rotatePoint(centerX, centerY, centerZ, rotX, rotY, rotZ);
      const pScaleCenter = fov / (fov + wcz + 260);
      const screenX = cx + wcx * pScaleCenter;
      const screenY = cy + wcy * pScaleCenter;

      // Cursor interaction: if mouse is near this sub-cube on screen, push it outward & heat it up!
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

      // Local sub-cube spin when split apart
      const localSpin = (breathWave * 0.55 + sc.hoverHeat * 0.65) * Math.sin(t * 2.0 + sc.phaseOffset);
      const lRx = localSpin * sc.ix;
      const lRy = localSpin * sc.iy;
      const lRz = localSpin * sc.iz;

      // Transform the 8 vertices of this sub-cube
      const worldVerts = UNIT_VERTS.map(([vx, vy, vz]) => {
        // Local scale + spin
        const [lx, ly, lz] = rotatePoint(vx * cubeHalf, vy * cubeHalf, vz * cubeHalf, lRx, lRy, lRz);
        // Translate to sub-cube center, then rotate by global cube rotation
        return rotatePoint(centerX + lx, centerY + ly, centerZ + lz, rotX, rotY, rotZ);
      });

      const screenVerts = worldVerts.map(([wx, wy, wz]) => {
        const s = fov / (fov + wz + 260);
        return [cx + wx * s, cy + wy * s, wz];
      });

      // Process the 6 faces
      FACES.forEach((face) => {
        const [i0, i1, i2, i3] = face.verts;
        const p0 = screenVerts[i0];
        const p1 = screenVerts[i1];
        const p2 = screenVerts[i2];
        const p3 = screenVerts[i3];

        // 2D cross product for backface culling
        const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        if (cross <= 0) return;

        const avgZ = (p0[2] + p1[2] + p2[2] + p3[2]) * 0.25;

        // Rotate face normal for lighting
        const [lnx, lny, lnz] = rotatePoint(face.normal[0], face.normal[1], face.normal[2], lRx, lRy, lRz);
        const [wnx, wny, wnz] = rotatePoint(lnx, lny, lnz, rotX, rotY, rotZ);

        // Directional light from top-left-front
        const lightDot = Math.max(0, wnx * -0.45 + wny * -0.55 + wnz * -0.7);

        renderList.push({
          type: 'face',
          z: avgZ,
          pts: [p0, p1, p2, p3],
          light: lightDot,
          heat: sc.hoverHeat,
          splitGlow: breathWave,
          isCorner: Math.abs(sc.ix) + Math.abs(sc.iy) + Math.abs(sc.iz) === 3
        });
      });
    });

    // Add orbiting 3D energy particles
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

    // Sort back-to-front (largest Z is farthest back)
    renderList.sort((a, b) => b.z - a.z);

    // Draw sorted primitives
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

      // Face fill: dark obsidian tinted with glowing orange & purple highlights
      const baseLit = 14 + item.light * 38;
      const heatBoost = item.heat * 130;
      const r = Math.min(255, Math.round(baseLit + item.light * 155 + heatBoost));
      const g = Math.min(255, Math.round(baseLit * 0.65 + item.light * 65 + heatBoost * 0.65));
      const b = Math.min(255, Math.round(baseLit * 0.9 + (item.isCorner ? 35 : 10) + heatBoost * 0.25));

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.92)`;
      ctx.fill();

      // Glowing Neon Orange wireframe edges (brighter when hovered or split)
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
   3. GLOWING TEXT BRIGHTNESS & VARIABLE WEIGHT INTERACTION WITH TRAIL/HOVER
   ========================================================================== */
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

function updateGlowingTextInteraction() {
  if (!pointer.hasMoved || !introFinished) return;

  const head = trailScreenPoints[0];
  const tail = trailScreenPoints[TRAIL_COUNT - 1];
  const trailSpan = Math.hypot(head.x - tail.x, head.y - tail.y);
  const trailActive = pointer.isDown || trailSpan > 8;

  const chars = document.querySelectorAll(
    '.page.active-page .glow-char, .navbar-desktop .glow-char, .navbar-mobile .glow-char'
  );
  const maxDist = trailActive ? 240 : 180;

  chars.forEach((span) => {
    const rect = span.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;

    let minDist = Math.hypot(cx - pointer.x, cy - pointer.y);

    if (trailActive) {
      for (let i = 0; i < TRAIL_COUNT; i += 2) {
        const tp = trailScreenPoints[i];
        const d = Math.hypot(cx - tp.x, cy - tp.y);
        if (d < minDist) minDist = d;
      }
    }

    const isVarWeight = span.dataset.variableWeight === 'true';
    const isSubtle = span.dataset.subtleGlow === 'true';

    if (isVarWeight) {
      const wght = Math.max(200, Math.min(900, Math.round(900 - minDist * 2)));
      span.style.fontVariationSettings = `'wght' ${wght}`;
    }

    if (minDist < maxDist) {
      const t = Math.pow(1 - minDist / maxDist, 1.5);
      const boost = trailActive ? t * 1.3 : t;

      if (isSubtle) {
        // Softer, toned-down glow specifically for the Quote section
        const midBlur = (0.06 + boost * 0.14).toFixed(3);
        const bright = (1 + boost * 0.28).toFixed(2);
        span.style.textShadow = `0 0 ${midBlur}em currentColor`;
        span.style.filter = `brightness(${bright})`;
      } else {
        const coreBlur = (0.04 + boost * 0.14).toFixed(3);
        const midBlur = (0.18 + boost * 0.36).toFixed(3);
        const outerBlur = (0.34 + boost * 0.7).toFixed(3);
        const bright = (1 + boost * 0.6).toFixed(2);
        span.style.textShadow = `0 0 ${coreBlur}em #ffffff, 0.03em 0 ${midBlur}em currentColor, 0 0 ${outerBlur}em currentColor`;
        span.style.filter = `brightness(${bright})`;
      }
    } else {
      span.style.textShadow = '';
      span.style.filter = '';
    }
  });
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
    }
    progress += 0.28;
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

  // Smoothly slide the vertical track to snap to the target page
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
  }, 760);
}

const pageAnimatedState = {};

function triggerPageAnimations(pageId) {
  const pageEl = document.getElementById(pageId);
  if (!pageEl) return;

  pageEl.querySelectorAll('.sort-text').forEach((el) => {
    scrambleElement(el);
  });

  // Page 5: Quote ("i have no idea what im doing / but it works lol" - Neri)
  if (pageId === 'talk' && !pageAnimatedState.talk) {
    pageAnimatedState.talk = true;
    runQuoteTypingAnimation();
  }

  // Page 6: Projects descriptions typing
  if (pageId === 'projects' && !pageAnimatedState.projects) {
    pageAnimatedState.projects = true;
    pageEl.querySelectorAll('.project-desc-typing').forEach((el, i) => {
      runSimpleTyping(el, el.dataset.text, i * 250);
    });
  }
}

function runQuoteTypingAnimation() {
  const line1El = document.getElementById('quote-line-1');
  const line2El = document.getElementById('quote-line-2');
  const authorEl = document.getElementById('quote-author');
  if (!line1El || !line2El) return;

  const text1 = '“i have no idea what im doing';
  const text2 = 'but it works lol”';

  line1El.innerHTML = '';
  line2El.innerHTML = '';
  authorEl.textContent = '';

  function typeVariableLine(container, str, delayMs) {
    return new Promise((resolve) => {
      setTimeout(() => {
        let idx = 0;
        const iv = setInterval(() => {
          const ch = str[idx];
          const span = document.createElement('span');
          const isQuote = ch === '“' || ch === '”';
          span.className = `glow-char${ch === ' ' ? ' whitespace' : ''}${isQuote ? ' text-secondary' : ''}`;
          span.dataset.variableWeight = 'true';
          span.dataset.subtleGlow = 'true';
          span.style.fontVariationSettings = "'wght' 300";
          span.textContent = ch;
          container.appendChild(span);
          idx++;
          if (idx >= str.length) {
            clearInterval(iv);
            resolve();
          }
        }, 60);
      }, delayMs);
    });
  }

  typeVariableLine(line1El, text1, 200)
    .then(() => typeVariableLine(line2El, text2, 250))
    .then(() => {
      runSimpleTyping(authorEl, '- Neri', 250);
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

  function renderGlowChars(container, str) {
    container.innerHTML = str
      .split('')
      .map((ch) => `<span class="glow-char${ch === ' ' ? ' whitespace' : ''}">${ch}</span>`)
      .join('');
  }

  async function loop() {
    await sleep(900);
    let idx = 0;
    while (true) {
      const word = tokens[idx];
      for (let i = 1; i <= word.length; i++) {
        renderGlowChars(el, word.slice(0, i));
        await sleep(typeSpeed);
      }
      await sleep(pauseTime);
      for (let i = word.length - 1; i >= 0; i--) {
        renderGlowChars(el, word.slice(0, i));
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

  // Default progress bar width points to 5th Semester (index 4 out of 7 nodes)
  // justify-evenly places N items at (i + 1) / (N + 1) -> (4 + 1) / 8 = 62.5%
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
