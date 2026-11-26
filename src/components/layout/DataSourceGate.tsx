import { Link } from "react-router-dom";

export function DataSourceGate() {
  return (
    <div className="data-gate">
      <div className="data-gate__card signal-card">
        <span className="data-gate__badge">Coming soon</span>
        <h1 className="data-gate__title">Live data isn&apos;t enabled in this build</h1>
        <p className="data-gate__lede">
          This preview build doesn&apos;t include a live market data connection. Full feeds with
          real-time quotes, fundamentals, and analyst targets will be available in a future release.
        </p>
        <p className="data-gate__lede">
          In the meantime, you can explore the scoring engine, how signals are built, and the app
          structure below.
        </p>

        <div className="data-gate__actions">
          <Link to="/core" className="btn btn--primary">
            How the engine works
          </Link>
          <Link to="/research" className="btn btn--ghost">
            Research Desk
          </Link>
        </div>
      </div>
    </div>
  );
}
