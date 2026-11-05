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
const BRANCH_RGB = '120, 78, 54';           // warm brown, readable on the dark bar
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

// Bresenham line on the art grid; alpha quantized to three steps so branches
// read as pixel art rather than anti-aliased strokes.
function pixelLine(g, x0, y0, x1, y1, alpha) {
  const a = alpha > 0.5 ? 0.55 : alpha > 0.25 ? 0.38 : 0.22;
  g.fillStyle = `rgba(${BRANCH_RGB}, ${a})`;
  let dx = Math.abs(x1 - x0); let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function drawSprite(g, sprite, cx, cy) {
  const oy = cy - (sprite.length >> 1);
  const ox = cx - (sprite[0].length >> 1);
  for (let y = 0; y < sprite.length; y += 1) {
    const row = sprite[y];
    for (let x = 0; x < row.length; x += 1) {
      const c = BLOSSOM_COLORS[row[x]];
      if (c) { g.fillStyle = c; g.fillRect(ox + x, oy + y, 1, 1); }
    }
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
    const blossom = bannerStyle === 'blossom';
    // Low-resolution art buffer and falling petals — blossom mode only, so the
    // network path (and its random sequence) is untouched.
    const art = blossom ? document.createElement('canvas') : null;
    const artCtx = art ? art.getContext('2d') : null;
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
      if (blossom) {
        art.width = Math.ceil(w / PIXEL);
        art.height = Math.ceil(h / PIXEL);
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
    }

    function drawBlossom() {
      const { w, h } = sizeRef.current;
      const nodes = nodesRef.current;
      const g = artCtx;
      g.clearRect(0, 0, art.width, art.height);
      // Branches first (behind blossoms), same distance rule as the network.
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (d < EDGE_DIST) {
            pixelLine(g,
              Math.round(nodes[i].x / PIXEL), Math.round(nodes[i].y / PIXEL),
              Math.round(nodes[j].x / PIXEL), Math.round(nodes[j].y / PIXEL),
              1 - d / EDGE_DIST);
          }
        }
      }
      for (const p of petals) {
        g.fillStyle = BLOSSOM_COLORS[p.shade];
        g.fillRect(Math.round(p.x + Math.sin(p.phase) * 1.2), Math.round(p.y), 1, 1);
      }
      for (const n of nodes) {
        drawSprite(g, n.r > 1.7 ? BLOSSOM_LARGE : BLOSSOM_SMALL,
          Math.round(n.x / PIXEL), Math.round(n.y / PIXEL));
      }
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.9;
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
      if (blossom) { drawBlossom(); return; }
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
      if (blossom) stepPetals();
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
