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
// Static scenic cherry grove (tm-clean 24) — original block-style pixel art,
// drawn once in code. GROVE_PIXEL = 2 css px per art pixel → 23 art rows in
// the 46 px bar. Layers, back to front: sky gradient + blocky clouds, a hazy
// distant tree line, midground trees (trunks, angular branches, canopies of
// 3×3 leaf blocks with a sunlit top face and shaded underside), ground (grass
// row over dirt-block sides, small pink flowers), foreground canopy undersides
// hanging from the top edge with the odd large trunk, and petals mid-air.
// Everything comes from one fixed-seed generator: the same every load, and the
// seeded spacing never repeats visibly at any width.
// ---------------------------------------------------------------------------

const GROVE_PIXEL = 2;
const GROVE_SEED = 20261105;
const SKY_TOP = hexRgb('#3E8EE0');
const SKY_HORIZON = hexRgb('#C4E6FF');
const CLOUD = ['#F7FBFF', '#E4EFF9', '#D3E3F2'].map(hexRgb);
const HAZE_LEAF = ['#F3DCE6', '#EACCDA', '#DDBCCC'].map(hexRgb);
const HAZE_TRUNK = hexRgb('#A99098');
const HAZE_MEADOW = ['#D8E9CF', '#CBE1C2', '#E6DDE3'].map(hexRgb);
// Leaf ramp, light → dark.
const LEAF = ['#FFF1F6', '#FCD9E7', '#F6B9D1', '#EC98BA', '#D47599', '#A9567A'].map(hexRgb);
const LEAF_WHITE = hexRgb('#FFFFFF');
const LEAF_FLECK = hexRgb('#C9D86C');
const TRUNK = ['#6A3634', '#55292A', '#3E1D1F', '#2E1517'].map(hexRgb);   // lit → shaded
const GRASS = ['#7CC34E', '#64AE3C', '#4F9431', '#3F7D28'].map(hexRgb);
const DIRT = ['#8A5E3C', '#77502F', '#634127'].map(hexRgb);
const FLOWER = ['#FF9FC6', '#F77FB0', '#FFD2E4'].map(hexRgb);
const PETAL = ['#FFC4DB', '#F7A6C8', '#FFE2EE'].map(hexRgb);

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const mix = (c1, c2, t) => [0, 1, 2].map((i) => c1[i] + (c2[i] - c1[i]) * t);

// One leaf block: sunlit top face, shaded underside, speckle, white
// highlights and the odd yellow-green fleck.
function leafBlock(R, rnd, x0, y0, size, shade = 0) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let i;
      if (y === 0) i = rnd() < 0.7 ? 1 : 0;                        // top face
      else if (y === size - 1) i = rnd() < 0.7 ? 4 : 3;            // underside
      else i = 2 + (rnd() < 0.35 ? 1 : 0) - (rnd() < 0.2 ? 1 : 0);  // body speckle
      let c = LEAF[Math.min(5, i + shade)];
      const r = rnd();
      if (y < size - 1 && r < 0.05) c = LEAF_WHITE;
      else if (r > 0.97) c = LEAF_FLECK;
      blend(R, x0 + x, y0 + y, c, 1);
    }
  }
}

// Stepped (angular) branch from (x0,y0) going up with slope dx per row.
function branch(R, rnd, x0, y0, len, dir) {
  let x = x0;
  for (let k = 0; k < len; k += 1) {
    blend(R, x, y0 - k, TRUNK[1 + (rnd() < 0.4 ? 1 : 0)], 1);
    if (k % 2 === 1) { x += dir; blend(R, x, y0 - k, TRUNK[2], 1); }
  }
}

function drawGrove(R) {
  const rnd = mulberry32(GROVE_SEED);
  const { gw, gh } = R;
  const groundTop = gh - 3;              // grass row; two dirt rows below
  const horizon = groundTop - 4;

  // Sky: vertical gradient, lighter toward the horizon.
  for (let y = 0; y < gh; y += 1) {
    const c = mix(SKY_TOP, SKY_HORIZON, Math.min(1, y / horizon));
    for (let x = 0; x < gw; x += 1) blend(R, x, y, c, 1);
  }
  // Blocky clouds (2-px blocks) high in the sky.
  for (let x = Math.floor(rnd() * 40); x < gw; x += 60 + Math.floor(rnd() * 90)) {
    const y = 1 + Math.floor(rnd() * 5);
    const wBlocks = 3 + Math.floor(rnd() * 5);
    for (let b = 0; b < wBlocks; b += 1) {
      const top = b > 0 && b < wBlocks - 1 && rnd() < 0.7;
      for (let px = 0; px < 2; px += 1) {
        blend(R, x + b * 2 + px, y + 1, CLOUD[1], 1);
        blend(R, x + b * 2 + px, y + 2, CLOUD[2], 1);
        if (top) blend(R, x + b * 2 + px, y, CLOUD[0], 1);
      }
    }
  }
  // Hazy far meadow between the distant tree line and the grass.
  for (let y = horizon + 1; y < groundTop; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      const c = HAZE_MEADOW[rnd() < 0.85 ? (y === horizon + 1 ? 0 : 1) : 2];
      blend(R, x, y, c, 1);
    }
  }
  // Distant tree line: small hazy canopies on thin trunks near the horizon.
  for (let x = -2; x < gw; x += 5 + Math.floor(rnd() * 7)) {
    const top = horizon - 4 - Math.floor(rnd() * 3);
    const wB = 2 + Math.floor(rnd() * 3);
    for (let yy = top + 4; yy <= horizon + 1; yy += 1) blend(R, x + wB, yy, HAZE_TRUNK, 1);
    for (let b = 0; b < wB; b += 1) {
      for (let yy = 0; yy < 4; yy += 1) {
        if (yy === 0 && (b === 0 || b === wB - 1)) continue;
        for (let px = 0; px < 2; px += 1) {
          blend(R, x + b * 2 + px, top + yy, HAZE_LEAF[yy === 0 ? 0 : yy === 3 ? 2 : (rnd() < 0.5 ? 0 : 1)], 1);
        }
      }
    }
  }

  // Midground trees.
  for (let x = Math.floor(rnd() * 12); x < gw + 10; x += 22 + Math.floor(rnd() * 26)) {
    const BS = 3;
    const wB = 5 + Math.floor(rnd() * 5);                 // canopy width in blocks
    const hB = 3 + (rnd() < 0.5 ? 1 : 0);                 // canopy height in blocks
    const canopyTop = 1 + Math.floor(rnd() * 3);
    const canopyBottom = canopyTop + hB * BS;
    const trunkX = x + Math.floor((wB * BS) / 2) - 1 + Math.floor(rnd() * 3) - 1;
    // Trunk (2 px: lit left, shaded right) down to the grass.
    for (let y = canopyBottom - 2; y < groundTop; y += 1) {
      blend(R, trunkX, y, TRUNK[rnd() < 0.8 ? 0 : 1], 1);
      blend(R, trunkX + 1, y, TRUNK[rnd() < 0.75 ? 2 : 3], 1);
    }
    // Angular branches reaching into the canopy, visible under it.
    branch(R, rnd, trunkX - 1, canopyBottom + 1, 4, -1);
    branch(R, rnd, trunkX + 2, canopyBottom + 2, 5, 1);
    if (rnd() < 0.5) branch(R, rnd, trunkX - 1, canopyBottom + 3, 3, -1);
    // Canopy: rows of blocks, narrower toward the top, ragged edges.
    for (let by = 0; by < hB; by += 1) {
      const inset = by === 0 ? 1 + Math.floor(rnd() * 2) : (by === hB - 1 && rnd() < 0.5 ? 1 : 0);
      for (let bx = inset; bx < wB - inset; bx += 1) {
        if ((bx === inset || bx === wB - inset - 1) && rnd() < 0.25) continue;
        leafBlock(R, rnd, x + bx * BS, canopyTop + by * BS, BS, by === hB - 1 ? 1 : 0);
      }
    }
    // A few leaf blocks drooping below the canopy edge.
    for (let k = 0; k < 2; k += 1) {
      if (rnd() < 0.6) leafBlock(R, rnd, x + (1 + Math.floor(rnd() * (wB - 2))) * BS, canopyBottom, BS, 1);
    }
  }

  // Ground: grass row with drips over dirt-block sides; small pink flowers.
  for (let x = 0; x < gw; x += 1) {
    blend(R, x, groundTop, GRASS[Math.floor(rnd() * 3)], 1);
    blend(R, x, groundTop + 1, rnd() < 0.35 ? GRASS[3] : DIRT[Math.floor(rnd() * 2)], 1);
    blend(R, x, groundTop + 2, DIRT[1 + Math.floor(rnd() * 2)], 1);
    if (x % 4 === 0) blend(R, x, groundTop + 2, DIRT[2], 1);    // dirt-block seams
  }
  for (let x = Math.floor(rnd() * 6); x < gw; x += 3 + Math.floor(rnd() * 9)) {
    blend(R, x, groundTop - 1, FLOWER[Math.floor(rnd() * 3)], 1);
    blend(R, x, groundTop, GRASS[3], 1);
  }

  // Foreground: big canopy undersides hanging from the top edge, cut off by
  // the banner, with the occasional large trunk.
  for (let x = 30 + Math.floor(rnd() * 60); x < gw; x += 90 + Math.floor(rnd() * 110)) {
    const BS = 4;
    const wB = 6 + Math.floor(rnd() * 6);
    const depth = 1 + Math.floor(rnd() * 2);               // rows of blocks shown
    for (let bx = 0; bx < wB; bx += 1) {
      const d = depth + ((bx > 0 && bx < wB - 1 && rnd() < 0.5) ? 1 : 0) - ((bx === 0 || bx === wB - 1) ? 1 : 0);
      for (let by = 0; by < d; by += 1) leafBlock(R, rnd, x + bx * BS, by * BS - 1, BS, 1);
    }
    if (rnd() < 0.35) {
      const tx = x + Math.floor(rnd() * (wB * BS - 6));
      for (let y = 0; y < groundTop + 1; y += 1) {
        for (let k = 0; k < 4; k += 1) {
          const c = k < 1 ? TRUNK[0] : k < 3 ? TRUNK[rnd() < 0.8 ? 1 : 2] : TRUNK[3];
          blend(R, tx + k, y, c, 1);
        }
      }
    }
  }

  // Petals frozen mid-air.
  for (let x = Math.floor(rnd() * 20); x < gw; x += 14 + Math.floor(rnd() * 30)) {
    blend(R, x, 2 + Math.floor(rnd() * (groundTop - 4)), PETAL[Math.floor(rnd() * 3)], 1);
  }
}

// Smooth dark gradient behind the title and nav (not pixelated): solid up to
// the nav's right edge, then fading out over GRADIENT_FADE css px.
const GRADIENT_RGB = '14, 14, 16';
const GRADIENT_ALPHA = 0.92;
const GRADIENT_FADE = 90;

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
        drawGrove(R);
        rasterFlush(R, groveCtx);
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(groveArt, 0, 0, groveArt.width * GROVE_PIXEL, groveArt.height * GROVE_PIXEL);
        // Readability: dark gradient behind the title and nav.
        const nav = parent.querySelector('.app-utility-nav');
        const navRight = nav ? nav.getBoundingClientRect().right - rect.left : 0;
        if (navRight > 0) {
          const g = ctx.createLinearGradient(0, 0, navRight + GRADIENT_FADE, 0);
          const solid = navRight / (navRight + GRADIENT_FADE);
          g.addColorStop(0, `rgba(${GRADIENT_RGB}, ${GRADIENT_ALPHA})`);
          g.addColorStop(solid, `rgba(${GRADIENT_RGB}, ${GRADIENT_ALPHA})`);
          g.addColorStop(1, `rgba(${GRADIENT_RGB}, 0)`);
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, navRight + GRADIENT_FADE, h);
        }
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
