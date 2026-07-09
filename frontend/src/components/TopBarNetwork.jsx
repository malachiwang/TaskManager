import { useEffect, useRef, useState } from 'react';
import { getMotionLevel } from '../appearance.js';

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

export default function TopBarNetwork({ className = '' }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const nodesRef = useRef([]);
  const pointerRef = useRef({ x: 0, y: 0, active: false });
  const sizeRef = useRef({ w: 0, h: 0 });

  // Background motion level ('off' | 'subtle' | 'lively') — user preference
  // from Settings. Changes re-run the effect so the loop starts/stops live.
  const [motionLevel, setMotionLevel] = useState(getMotionLevel);
  useEffect(() => {
    function onAppearanceChange() {
      setMotionLevel(getMotionLevel());
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
    }

    function draw() {
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
  }, [motionLevel]);

  return <canvas ref={canvasRef} className={`topbar-network-canvas ${className}`} aria-hidden="true" />;
}
