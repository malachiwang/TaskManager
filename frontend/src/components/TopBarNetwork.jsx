import { useEffect, useRef, useState } from 'react';
import { getMotionLevel, getBannerStyle } from '../appearance.js';

// TopBarNetwork (P8.0B) — a subtle node-and-edge network drawn on a <canvas>
// that fills its positioned parent. It is background-only: the canvas is
// pointer-events:none so it never intercepts toolbar clicks. White/faint-gray
// nodes drift slowly; nearby nodes connect with thin faint edges; the cursor
// (while over the parent) gently repels nearby nodes, which settle back when it
// leaves. No dependencies, no colour — just canvas + requestAnimationFrame.
//
// The same component backs both the black top bar and the loading screen; it
// adapts node count to the container size, so a wide short bar and a full-screen
// overlay both look coherent.
//
// Accessibility: prefers-reduced-motion renders a single static frame (no
// animation loop, no cursor repulsion).

const EDGE_DIST = 118;        // px — max distance for an edge to be drawn
const REPEL_RADIUS = 96;      // px — cursor influence radius
const REPEL_FORCE = 0.55;     // impulse strength at the cursor
const DAMPING = 0.94;         // velocity decay per frame → nodes settle
const MIN_NODES = 10;
const MAX_NODES = 45;

// Baseline drift per motion level (P10.0). "subtle" is ~20% above the old
// 0.018 wander so the field is visibly alive; "lively" is a step further but
// still calm — cursor repulsion is unchanged in every level.
const MOTION_TUNING = {
  subtle: { wander: 0.022, maxSpeed: 1.25 },
  lively: { wander: 0.032, maxSpeed: 1.45 },
};

const NODE_RGB = '255, 255, 255';

// Cherry-blossom banner (tm-clean 21): the same node field drawn as pixel art
// on a low-resolution grid (PIXEL css px per art pixel), scaled up with image
// smoothing off so it stays crisp. Original art, drawn in code.
const PIXEL = 3;
const BLOSSOM_COLORS = { 0: '#FFE4EF', 1: '#F7C6D9', 2: '#EE9BBE', 3: '#D96C9A' };
const BLOSSOM_SMALL = ['.1.', '132', '.2.'];
const BLOSSOM_LARGE = ['..1..', '.012.', '10321', '.223.', '..2..'];
const PETAL_COUNT = 9;

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Width-driven count keeps the wide/short top bar from looking empty while
// small screens (and the avoid-clutter goal) stay sparse.
function nodeCountFor(width) {
  const n = Math.round(width / 34);
  return Math.max(MIN_NODES, Math.min(MAX_NODES, n));
}

// ---------------------------------------------------------------------------
// Pixel modes (tm-clean 21/22). Each frame is composed in a small RGBA buffer
// at art resolution (PIXEL css px per art pixel) — premultiplied, standard
// source-over — pushed to a small canvas once with putImageData and scaled up
// with smoothing off. No per-pixel canvas calls.
// ---------------------------------------------------------------------------

const BRANCH = [120, 78, 54];
const WHITE = [255, 255, 255];
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BLOSSOM_RGB = Object.fromEntries(Object.entries(BLOSSOM_COLORS).map(([k, v]) => [k, hexRgb(v)]));

function makeRaster(gw, gh, ctx2d) {
  return { gw, gh, buf: new Float32Array(gw * gh * 4), img: ctx2d.createImageData(gw, gh) };
}

function blend(R, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= R.gw || y >= R.gh) return;
  const i = (y * R.gw + x) * 4;
  const k = 1 - a;
  const b = R.buf;
  b[i] = rgb[0] * a + b[i] * k;
  b[i + 1] = rgb[1] * a + b[i + 1] * k;
  b[i + 2] = rgb[2] * a + b[i + 2] * k;
  b[i + 3] = a + b[i + 3] * k;
}

function rasterFlush(R, artCtx) {
  const b = R.buf; const d = R.img.data;
  for (let i = 0; i < b.length; i += 4) {
    const A = b[i + 3];
    if (A > 0) {
      d[i] = Math.round(b[i] / A); d[i + 1] = Math.round(b[i + 1] / A); d[i + 2] = Math.round(b[i + 2] / A);
      d[i + 3] = Math.round(A * 255);
    } else { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; }
  }
  artCtx.putImageData(R.img, 0, 0);
}

// Bresenham line on the art grid.
function rasterLine(R, x0, y0, x1, y1, rgb, a) {
  const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    blend(R, x0, y0, rgb, a);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Branch alpha quantized to three steps so branches read as pixel art.
const branchAlpha = (t) => (t > 0.5 ? 0.55 : t > 0.25 ? 0.38 : 0.22);

function rasterSprite(R, sprite, cx, cy) {
  const oy = cy - (sprite.length >> 1);
  const ox = cx - (sprite[0].length >> 1);
  for (let y = 0; y < sprite.length; y += 1) {
    const row = sprite[y];
    for (let x = 0; x < row.length; x += 1) {
      const c = BLOSSOM_RGB[row[x]];
      if (c) blend(R, ox + x, oy + y, c, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Static cherry grove (tm-clean 22) — original block-style pixel art, drawn
// once. GROVE_PIXEL = 2 css px per art pixel: the 46 px bar gives 23 art rows,
// enough for a 3-row ground strip and trees ~20 rows tall built from 4×4 blocks.
// Deterministic textures from a fixed-seed generator (never Math.random).
// ---------------------------------------------------------------------------

const GROVE_PIXEL = 2;
const GROVE_BLOCK = 4;
const LEAF = ['#FFE4EF', '#F7C6D9', '#EE9BBE', '#D96C9A'].map(hexRgb);
const BARK = ['#5B3A29', '#4A2E20', '#6E4632'].map(hexRgb);
const GRASS = ['#5E8C3A', '#4F7A30', '#6FA044'].map(hexRgb);
const DIRT = ['#6B4A32', '#5A3D28', '#7A5539'].map(hexRgb);
// Canopy shapes in blocks, top row first ('#' = leaf block).
const CANOPIES = [
  [' ### ', '#####', '#####'],
  ['  ##  ', ' #### ', '######', '  ##  '],
  [' ## ', '####', '####'],
  ['  #  ', ' ### ', '#####'],
];

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Trees and ground left of `fadeUntil` (art px — the brand + nav area) are
// drawn at FADED_TREE_ALPHA so the brand text and nav labels stay readable.
const FADED_TREE_ALPHA = 0.35;

function drawGrove(R, fadeUntil = 0) {
  const rnd = mulberry32(20261105);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const { gw, gh } = R;
  const groundTop = gh - 3;
  // Ground: one row of grass, two of dirt, speckled.
  for (let x = 0; x < gw; x += 1) {
    const ga = x < fadeUntil ? FADED_TREE_ALPHA : 1;
    blend(R, x, groundTop, pick(GRASS), ga);
    blend(R, x, groundTop + 1, rnd() < 0.3 ? pick(GRASS) : pick(DIRT), ga);
    blend(R, x, groundTop + 2, pick(DIRT), ga);
  }
  // Trees across the banner.
  let x = 4 + Math.floor(rnd() * 10);
  while (x < gw - 8) {
    const shape = pick(CANOPIES);
    const cw = shape[0].length * GROVE_BLOCK;
    const ch = shape.length * GROVE_BLOCK;
    const trunkH = Math.max(4, groundTop - ch - Math.floor(rnd() * 3));
    const canopyTop = groundTop - trunkH - ch + 2;   // canopy overlaps the trunk top
    const trunkX = x + (cw >> 1) - 1;
    const ta = x < fadeUntil ? FADED_TREE_ALPHA : 1;
    // Trunk: 2 px wide, bark texture in dark wood tones.
    for (let y = groundTop - trunkH; y < groundTop; y += 1) {
      blend(R, trunkX, y, rnd() < 0.7 ? BARK[0] : BARK[1], ta);
      blend(R, trunkX + 1, y, rnd() < 0.6 ? BARK[2] : BARK[0], ta);
    }
    // Canopy: square leaf blocks, each with its own base pink and speckles.
    shape.forEach((row, by) => {
      [...row].forEach((cell, bx) => {
        if (cell !== '#') return;
        const base = 1 + Math.floor(rnd() * 2);
        for (let py = 0; py < GROVE_BLOCK; py += 1) {
          for (let px = 0; px < GROVE_BLOCK; px += 1) {
            const r = rnd();
            const shade = r < 0.55 ? base : r < 0.75 ? base - 1 : r < 0.95 ? base + 1 : 3;
            blend(R, x + bx * GROVE_BLOCK + px, canopyTop + by * GROVE_BLOCK + py, LEAF[Math.max(0, Math.min(3, shade))], ta);
          }
        }
      });
    });
    // A few fallen petals on the grass under the tree.
    for (let i = 0; i < 3; i += 1) {
      blend(R, x + Math.floor(rnd() * (cw + 6)) - 3, groundTop, LEAF[1 + Math.floor(rnd() * 3)], ta);
    }
    x += cw + 8 + Math.floor(rnd() * 22);
  }
}

export default function TopBarNetwork({ className = '', followBanner = false }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const nodesRef = useRef([]);
  const pointerRef = useRef({ x: 0, y: 0, active: false });
  const sizeRef = useRef({ w: 0, h: 0 });

  // Background motion level ('off' | 'subtle' | 'lively') — user preference
  // from Settings. Changes re-run the effect so the loop starts/stops live.
  const [motionLevel, setMotionLevel] = useState(getMotionLevel);
  // Banner art — only the header follows the Settings choice (followBanner);
  // the loading screen always shows the network.
  const [bannerStyle, setBannerStyle] = useState(() => (followBanner ? getBannerStyle() : 'network'));
  useEffect(() => {
    function onAppearanceChange() {
      setMotionLevel(getMotionLevel());
      if (followBanner) setBannerStyle(getBannerStyle());
    }
    window.addEventListener('taskos-appearance-change', onAppearanceChange);
    return () => window.removeEventListener('taskos-appearance-change', onAppearanceChange);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const parent = canvas.parentElement;
    if (!parent) return undefined;
    const ctx = canvas.getContext('2d');
    // Reduced-motion OS preference always wins; Motion "Off" draws the same
    // static frame with no animation loop.
    const reduced = prefersReducedMotion() || motionLevel === 'off';
    const tuning = MOTION_TUNING[motionLevel] || MOTION_TUNING.subtle;

    // Static cherry grove: drawn once (and on resize / appearance change). No
    // nodes, no animation loop, no cursor interaction.
    if (bannerStyle === 'cherry') {
      const groveArt = document.createElement('canvas');
      const groveCtx = groveArt.getContext('2d');
      const paint = () => {
        const rect = parent.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        groveArt.width = Math.ceil(w / GROVE_PIXEL);
        groveArt.height = Math.ceil(h / GROVE_PIXEL);
        const R = makeRaster(groveArt.width, groveArt.height, groveCtx);
        // Brand + nav area: from the bar's left edge to the nav's right edge.
        const nav = parent.querySelector('.app-utility-nav');
        const navRight = nav ? nav.getBoundingClientRect().right - rect.left : 0;
        drawGrove(R, Math.ceil(navRight / GROVE_PIXEL));
        rasterFlush(R, groveCtx);
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(groveArt, 0, 0, groveArt.width * GROVE_PIXEL, groveArt.height * GROVE_PIXEL);
      };
      paint();
      const groveRo = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
      if (groveRo) {
        groveRo.observe(parent);
        // The nav changes width when Main's views slide open/closed.
        const nav = parent.querySelector('.app-utility-nav');
        if (nav) groveRo.observe(nav);
      } else window.addEventListener('resize', paint);
      window.addEventListener('taskos-appearance-change', paint);
      return () => {
        if (groveRo) groveRo.disconnect(); else window.removeEventListener('resize', paint);
        window.removeEventListener('taskos-appearance-change', paint);
      };
    }

    // Pixel modes share the animated node field; Network's own draw path (and
    // its random sequence) is untouched.
    const pixelBlossom = bannerStyle === 'pixel-blossom';
    const pixelNet = bannerStyle === 'pixel-network';
    const pixelMode = pixelBlossom || pixelNet;
    const art = pixelMode ? document.createElement('canvas') : null;
    const artCtx = art ? art.getContext('2d') : null;
    let raster = null;
    let petals = [];

    function seedNodes(w, h) {
      const count = nodeCountFor(w);
      const nodes = [];
      for (let i = 0; i < count; i += 1) {
        nodes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          r: 1 + Math.random() * 1.4,
        });
      }
      nodesRef.current = nodes;
    }

    function resize() {
      const rect = parent.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const prev = sizeRef.current;
      sizeRef.current = { w, h };
      // Re-seed only when the node field is empty or the width band changed
      // meaningfully; avoids scattering nodes on every tiny resize tick.
      if (!nodesRef.current.length || nodeCountFor(w) !== nodeCountFor(prev.w || w)) {
        seedNodes(w, h);
      }
      if (pixelMode) {
        art.width = Math.ceil(w / PIXEL);
        art.height = Math.ceil(h / PIXEL);
        raster = makeRaster(art.width, art.height, artCtx);
      }
      if (pixelBlossom) {
        if (!petals.length) {
          for (let i = 0; i < PETAL_COUNT; i += 1) {
            petals.push({
              x: Math.random() * art.width,
              y: Math.random() * art.height,
              vy: 0.025 + Math.random() * 0.03,
              phase: Math.random() * Math.PI * 2,
              shade: i % 2 ? 1 : 2,
            });
          }
        }
      }
      // Resizing clears the canvas. With reduced motion (OS setting or Motion
      // "Off") there is no animation loop to repaint it, so redraw the still
      // frame here — before tm-clean 23 the banner ended up blank.
      if (reduced) draw();
    }

    function drawPixel() {
      const { w, h } = sizeRef.current;
      const nodes = nodesRef.current;
      const R = raster;
      R.buf.fill(0);
      // Edges first, same distance rule as the network.
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (d < EDGE_DIST) {
            const t = 1 - d / EDGE_DIST;
            rasterLine(R,
              Math.round(nodes[i].x / PIXEL), Math.round(nodes[i].y / PIXEL),
              Math.round(nodes[j].x / PIXEL), Math.round(nodes[j].y / PIXEL),
              pixelBlossom ? BRANCH : WHITE, pixelBlossom ? branchAlpha(t) : t * 0.22);
          }
        }
      }
      if (pixelBlossom) {
        for (const p of petals) {
          blend(R, Math.round(p.x + Math.sin(p.phase) * 1.2), Math.round(p.y), BLOSSOM_RGB[p.shade], 1);
        }
        for (const n of nodes) {
          rasterSprite(R, n.r > 1.7 ? BLOSSOM_LARGE : BLOSSOM_SMALL,
            Math.round(n.x / PIXEL), Math.round(n.y / PIXEL));
        }
      } else {
        for (const n of nodes) blend(R, Math.round(n.x / PIXEL), Math.round(n.y / PIXEL), WHITE, 0.55);
      }
      rasterFlush(R, artCtx);
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = pixelBlossom ? 0.9 : 1;
      ctx.drawImage(art, 0, 0, art.width * PIXEL, art.height * PIXEL);
      ctx.globalAlpha = 1;
    }

    function stepPetals() {
      for (const p of petals) {
        p.y += p.vy;
        p.phase += 0.02;
        if (p.y > art.height + 1) { p.y = -1; p.x = Math.random() * art.width; }
      }
    }

    function draw() {
      if (pixelMode) { drawPixel(); return; }
      const { w, h } = sizeRef.current;
      const nodes = nodesRef.current;
      ctx.clearRect(0, 0, w, h);

      // Edges first (behind nodes). Fade with distance; cap by distance only.
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const d = Math.hypot(dx, dy);
          if (d < EDGE_DIST) {
            const alpha = (1 - d / EDGE_DIST) * 0.22;
            ctx.strokeStyle = `rgba(${NODE_RGB}, ${alpha.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Nodes.
      for (const n of nodes) {
        ctx.fillStyle = `rgba(${NODE_RGB}, 0.55)`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function step() {
      const { w, h } = sizeRef.current;
      const nodes = nodesRef.current;
      const p = pointerRef.current;
      for (const n of nodes) {
        // Gentle Brownian wander.
        n.vx += (Math.random() - 0.5) * tuning.wander;
        n.vy += (Math.random() - 0.5) * tuning.wander;

        // Cursor repulsion (only while pointer is over the parent).
        if (p.active) {
          const dx = n.x - p.x;
          const dy = n.y - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 0.01 && d2 < REPEL_RADIUS * REPEL_RADIUS) {
            const d = Math.sqrt(d2);
            const f = (1 - d / REPEL_RADIUS) * REPEL_FORCE;
            n.vx += (dx / d) * f;
            n.vy += (dy / d) * f;
          }
        }

        n.vx *= DAMPING;
        n.vy *= DAMPING;

        // Speed cap keeps the field calm even under heavy cursor pushing.
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > tuning.maxSpeed) {
          n.vx = (n.vx / sp) * tuning.maxSpeed;
          n.vy = (n.vy / sp) * tuning.maxSpeed;
        }

        n.x += n.vx;
        n.y += n.vy;

        // Soft reflect at the edges — keeps nodes on-screen without long
        // wrap-around edges shooting across the canvas.
        if (n.x < 0) { n.x = 0; n.vx = -n.vx * 0.6; }
        else if (n.x > w) { n.x = w; n.vx = -n.vx * 0.6; }
        if (n.y < 0) { n.y = 0; n.vy = -n.vy * 0.6; }
        else if (n.y > h) { n.y = h; n.vy = -n.vy * 0.6; }
      }
      if (pixelBlossom) stepPetals();
      draw();
      rafRef.current = requestAnimationFrame(step);
    }

    function onPointerMove(e) {
      const rect = parent.getBoundingClientRect();
      pointerRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        active: true,
      };
    }
    function onPointerLeave() {
      pointerRef.current.active = false;
    }
    function onVisibility() {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      } else if (!reduced && !rafRef.current) {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    resize();

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(resize)
      : null;
    if (ro) ro.observe(parent);
    else window.addEventListener('resize', resize);

    if (reduced) {
      // Static single frame — no loop, no cursor interaction.
      draw();
    } else {
      // Repulsion follows the cursor over the parent (not the canvas, which is
      // pointer-events:none). Touch is left as idle drift only.
      parent.addEventListener('pointermove', onPointerMove);
      parent.addEventListener('pointerleave', onPointerLeave);
      document.addEventListener('visibilitychange', onVisibility);
      rafRef.current = requestAnimationFrame(step);
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', resize);
      parent.removeEventListener('pointermove', onPointerMove);
      parent.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [motionLevel, bannerStyle]);

  return <canvas ref={canvasRef} className={`topbar-network-canvas ${className}`} aria-hidden="true" />;
}
