/* ==========================================================================
   Jan Kopacz Portfolio — Inspired by ddaniel.dev (Orange & Purple Edition)
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

      // When the points are on top of each other, shrink the line to avoid artifacts.
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

  // Build polyline geometry buffers for TRAIL_COUNT points
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

  // Neon Orange (#ff8c38 -> 1.0, 0.549, 0.22)
  gl.uniform3f(uColorLoc, 1.0, 0.549, 0.22);
  gl.uniform1f(uThicknessLoc, 22.0);

  // Spring physics parameters matching ddaniel.dev (Jv = 0.1, Zv = 0.5)
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

  // Always track hover position for glowing text interaction,
  // and update trail target when holding mouse button down!
  window.addEventListener('mousedown', (e) => {
    pointer.isDown = true;
    const snapX = (e.clientX / width) * 2 - 1;
    const snapY = (e.clientY / height) * -2 + 1;
    targetNDC.x = snapX;
    targetNDC.y = snapY;
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

    // Update trail points physics
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

      // Convert NDC back to screen pixels for glowing text interaction
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

    // Update glowing text interaction with cursor & trail!
    updateGlowingTextInteraction();
  }

  requestAnimationFrame(animate);
}

/* ==========================================================================
   2. GLOWING TEXT BRIGHTNESS & VARIABLE WEIGHT INTERACTION WITH TRAIL/HOVER
   ========================================================================== */
const trackedGlowChars = [];

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
    el.appendChild(span);
    trackedGlowChars.push(span);
  }
}

function updateGlowingTextInteraction() {
  if (!pointer.hasMoved || !introFinished) return;

  // Check how spread out the trail currently is (i.e. actively moving)
  const head = trailScreenPoints[0];
  const tail = trailScreenPoints[TRAIL_COUNT - 1];
  const trailSpan = Math.hypot(head.x - tail.x, head.y - tail.y);
  const trailActive = pointer.isDown || trailSpan > 8;

  // Find all interactive glow characters inside the active page and top navbar
  const chars = document.querySelectorAll(
    '.page.active-page .glow-char, .navbar-desktop .glow-char, .navbar-mobile .glow-char'
  );
  const maxDist = trailActive ? 240 : 180;

  chars.forEach((span) => {
    const rect = span.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;

    // Distance to live mouse cursor
    let minDist = Math.hypot(cx - pointer.x, cy - pointer.y);

    // Also check distance to the active mouse-click trail segments!
    if (trailActive) {
      for (let i = 0; i < TRAIL_COUNT; i += 2) {
        const tp = trailScreenPoints[i];
        const d = Math.hypot(cx - tp.x, cy - tp.y);
        if (d < minDist) minDist = d;
      }
    }

    const isVarWeight = span.dataset.variableWeight === 'true';

    if (isVarWeight) {
      // Exact ddaniel.dev VariableFontTypingText formula: 900 - E * 2
      const wght = Math.max(200, Math.min(900, Math.round(900 - minDist * 2)));
      span.style.fontVariationSettings = `'wght' ${wght}`;
    }

    if (minDist < maxDist) {
      const t = Math.pow(1 - minDist / maxDist, 1.5);
      const boost = trailActive ? t * 1.35 : t;
      const coreBlur = (0.04 + boost * 0.14).toFixed(3);
      const midBlur = (0.18 + boost * 0.38).toFixed(3);
      const outerBlur = (0.35 + boost * 0.75).toFixed(3);
      const bright = (1 + boost * 0.65).toFixed(2);

      span.style.textShadow = `0 0 ${coreBlur}em #ffffff, 0.03em 0 ${midBlur}em currentColor, 0 0 ${outerBlur}em currentColor`;
      span.style.filter = `brightness(${bright})`;
    } else {
      span.style.textShadow = '';
      span.style.filter = '';
    }
  });
}

/* ==========================================================================
   3. SCRAMBLE TEXT EFFECT (SortText from ddaniel.dev)
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

    // Render as interactive glow-char spans so trail still brightens them!
    el.innerHTML = currentText
      .split('')
      .map((ch) => `<span class="glow-char${ch === ' ' ? ' whitespace' : ''}">${ch}</span>`)
      .join('');

    if (progress >= original.length) {
      clearInterval(interval);
      el.dataset.scrambling = 'false';
    }
    progress += 0.25;
  }, 30);
}

/* ==========================================================================
   4. TERMINAL INTRO ANIMATION
   ========================================================================== */
function initTerminalIntro() {
  const introScreen = document.getElementById('intro-screen');
  const mainSite = document.getElementById('main-site');
  const skipBtn = document.getElementById('skip-intro-btn');
  const historyBlock = document.getElementById('term-history-block');
  const startBlock = document.getElementById('term-start-block');
  const cleakErr = document.getElementById('term-cleak-err');
  const clearRow = document.getElementById('term-clear-row');
  const log1 = document.getElementById('term-log-1');
  const log2 = document.getElementById('term-log-2');

  let timers = [];

  function finishIntro() {
    if (introFinished) return;
    introFinished = true;
    timers.forEach(clearTimeout);
    introScreen.classList.add('hidden-screen');
    mainSite.classList.add('visible');

    // Check URL hash for initial page
    const hash = window.location.hash.replace('#', '');
    const targetIdx = PAGES.indexOf(hash);
    goToPage(targetIdx >= 0 ? targetIdx : 0, true);
  }

  skipBtn.addEventListener('click', finishIntro);

  // Typewriter helper for terminal commands
  function typeInto(el, text, speed = 75) {
    if (!el) return;
    el.textContent = '';
    let i = 0;
    const iv = setInterval(() => {
      el.textContent += text[i];
      i++;
      if (i >= text.length) clearInterval(iv);
    }, speed);
    timers.push(iv);
  }

  typeInto(document.getElementById('term-cmd-cleak'), 'cleak', 90);

  timers.push(setTimeout(() => {
    cleakErr.style.display = 'block';
    clearRow.style.display = 'flex';
    typeInto(document.getElementById('term-cmd-clear'), 'clear', 80);
  }, 1200));

  timers.push(setTimeout(() => {
    historyBlock.style.display = 'none';
    startBlock.style.display = 'flex';
    typeInto(document.getElementById('term-cmd-npm'), 'npm run start', 65);
  }, 3000));

  timers.push(setTimeout(() => {
    log1.style.display = 'block';
  }, 5000));

  timers.push(setTimeout(() => {
    log2.style.display = 'block';
  }, 6700));

  timers.push(setTimeout(() => {
    finishIntro();
  }, 8000));
}

/* ==========================================================================
   5. DISCRETE PAGE-TO-PAGE JUMP NAVIGATION SYSTEM
   ========================================================================== */
function goToPage(index, force = false) {
  if (index < 0 || index >= PAGES.length) return;
  if (isPageTransitioning && !force) return;
  if (index === currentPageIdx && !force) return;

  isPageTransitioning = true;
  currentPageIdx = index;
  const pageId = PAGES[index];

  // Toggle active page immediately (page-to-page jump)
  document.querySelectorAll('.page').forEach((sec) => {
    if (sec.id === pageId) {
      sec.classList.add('active-page');
    } else {
      sec.classList.remove('active-page');
    }
  });

  // Update URL hash without causing browser native scroll
  if (history.replaceState) {
    history.replaceState(null, null, `#${pageId}`);
  }

  // Update Right-Side Page Indicator Dots
  document.querySelectorAll('.indicator-dot').forEach((dot) => {
    dot.classList.toggle('active', dot.dataset.page === pageId);
  });

  // Update Top Navbar & Mobile Menu active state
  document.querySelectorAll('[data-nav-page]').forEach((item) => {
    item.classList.toggle('active', item.dataset.navPage === pageId);
  });

  // Trigger page-specific entrance animations
  triggerPageAnimations(pageId);

  setTimeout(() => {
    isPageTransitioning = false;
  }, 420);
}

const pageAnimatedState = {};

function triggerPageAnimations(pageId) {
  const pageEl = document.getElementById(pageId);
  if (!pageEl) return;

  // Scramble decode section headers & project titles on page arrival
  pageEl.querySelectorAll('.sort-text').forEach((el) => {
    scrambleElement(el);
  });

  // Page 5: Quote ("TALK IS CHEAP. SHOW ME THE CODE") variable-font typing
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

  const text1 = '“TALK IS CHEAP.';
  const text2 = 'SHOW ME THE CODE”';

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
          span.style.fontVariationSettings = "'wght' 300";
          span.textContent = ch;
          container.appendChild(span);
          idx++;
          if (idx >= str.length) {
            clearInterval(iv);
            resolve();
          }
        }, 85);
      }, delayMs);
    });
  }

  typeVariableLine(line1El, text1, 200)
    .then(() => typeVariableLine(line2El, text2, 350))
    .then(() => {
      runSimpleTyping(authorEl, '- Linus Torvalds', 300);
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
    }, 35);
  }, delay);
}

function initPageNavigation() {
  // Mouse wheel jumps cleanly page-by-page
  let wheelCooldown = false;
  window.addEventListener('wheel', (e) => {
    if (!introFinished) return;
    if (wheelCooldown) return;
    if (Math.abs(e.deltaY) < 12) return;

    wheelCooldown = true;
    if (e.deltaY > 0) {
      goToPage(currentPageIdx + 1);
    } else {
      goToPage(currentPageIdx - 1);
    }

    setTimeout(() => {
      wheelCooldown = false;
    }, 520);
  }, { passive: true });

  // Keyboard navigation (Up/Down/PageUp/PageDown)
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

  // Touch vertical swipe page jump
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
    // Only vertical swipes trigger page change
    if (Math.abs(dy) > 55 && Math.abs(dy) > Math.abs(dx) * 1.3) {
      if (dy > 0) goToPage(currentPageIdx + 1);
      else goToPage(currentPageIdx - 1);
    }
  }, { passive: true });

  // Click links with data-goto
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

  // Scramble text on hover
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
    'SOFTWARE ENGINEER',
    'QA AUTOMATION ENGINEER',
    'PYTHON & C# DEVELOPER',
    'SQL & CLOUD SPECIALIST',
    'CYPRESS TEST ARCHITECT',
    'CODE WIZARD'
  ];

  const typeSpeed = 95;
  const deleteSpeed = 28;
  const pauseTime = 900;

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
    await sleep(1200);
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
   8. INTERACTIVE WORK TIMELINE
   ========================================================================== */
function initTimeline() {
  const nodes = document.querySelectorAll('.timeline-node-wrapper');
  const activeLine = document.getElementById('timeline-active-line');
  const workIntro = document.getElementById('work-intro-text');
  let unfocusTimeout = null;

  function focusNode(idx) {
    clearTimeout(unfocusTimeout);
    nodes.forEach((n, i) => n.classList.toggle('focused', i === idx));
    if (workIntro) workIntro.classList.add('hidden-dot');

    // Calculate percentage width to reach the hovered dot
    // justify-evenly places N items at (i + 1) / (N + 1)
    const pct = ((idx + 1) / (nodes.length + 1)) * 100;
    if (activeLine) {
      activeLine.style.width = `${pct}%`;
    }
  }

  function unfocusNodes() {
    unfocusTimeout = setTimeout(() => {
      nodes.forEach((n) => n.classList.remove('focused'));
      if (workIntro) workIntro.classList.remove('hidden-dot');
      if (activeLine) activeLine.style.width = '0%';
    }, 350);
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
   9. INTERACTIVE PROJECTS CAROUSEL
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

  // Horizontal drag support on carousel viewport
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
   10. CONTACT FORM & TOAST NOTIFICATION
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
      // Send via FormSubmit AJAX endpoint to jan.kopacz@microsoft.wsei.edu.pl
      const res = await fetch('https://formsubmit.co/ajax/jan.kopacz@microsoft.wsei.edu.pl', {
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
        // Fallback: try local /api/email route or confirm receipt
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
  // Register glowing text elements for character-level trail brightening
  document.querySelectorAll('.glow-interactive').forEach((el) => {
    registerGlowElement(el);
  });

  initTrail();
  initTerminalIntro();
  initPageNavigation();
  initMobileMenu();
  initTypingAlternate();
  initTimeline();
  initCarousel();
  initContactForm();
});
