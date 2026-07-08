import TopBarNetwork from './TopBarNetwork.jsx';

// LoadingScreen (P8.0B) — a lightweight full-screen boot overlay that shares the
// top bar's visual language: black background, faint white node-edge network,
// centered app name. It is intentionally minimal (no long intro animation) and
// only appears while the app is confirming the backend is reachable. It respects
// reduced-motion via TopBarNetwork (which renders a static field in that case).
export default function LoadingScreen({ subtitle = 'Loading workspace…' }) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-network">
        <TopBarNetwork />
      </div>
      <div className="loading-content">
        <div className="loading-title">TaskManager</div>
        <div className="loading-subtitle">{subtitle}</div>
      </div>
    </div>
  );
}
