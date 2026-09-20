const SUBSYSTEMS = [
  "Event feed",
  "Map service",
  "Classification engine",
  "Infrastructure index",
] as const;

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 flex-none items-center justify-between gap-4 border-b border-border bg-surface px-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            GeoIntel
          </h1>
          <span className="hidden truncate text-xs text-foreground-muted sm:inline">
            Geospatial Event Monitoring
          </span>
        </div>

        <div
          className="badge"
          role="status"
          aria-live="polite"
          aria-label="System status: initializing"
        >
          <span className="status-dot status-dot-warning status-dot-pulse" aria-hidden="true" />
          Initializing
        </div>
      </header>

      <main
        id="main-content"
        className="grid flex-1 grid-cols-1 gap-3 p-3 md:p-4 lg:grid-cols-[minmax(0,1fr)_20rem]"
      >
        <section
          aria-labelledby="workspace-heading"
          className="panel flex min-h-[24rem] flex-col lg:min-h-0"
        >
          <div className="panel-header">
            <h2 id="workspace-heading" className="panel-title">
              Operational View
            </h2>
            <span className="text-label">Standby</span>
          </div>

          <div className="map-grid-backdrop flex flex-1 items-center justify-center p-6">
            <div className="panel-elevated max-w-sm px-5 py-4">
              <p className="text-sm font-medium text-foreground">
                Dashboard is initializing
              </p>
              <p className="mt-1 text-[0.8125rem] leading-relaxed text-foreground-secondary">
                The map, event detections and investigation tools will appear
                here once the workspace has loaded.
              </p>
            </div>
          </div>
        </section>

        <aside aria-labelledby="status-heading" className="panel h-fit">
          <div className="panel-header">
            <h2 id="status-heading" className="panel-title">
              System Status
            </h2>
          </div>

          <ul className="divide-y divide-border-subtle">
            {SUBSYSTEMS.map((name) => (
              <li
                key={name}
                className="flex items-center justify-between gap-3 px-3.5 py-2.5"
              >
                <span className="text-[0.8125rem] text-foreground-secondary">
                  {name}
                </span>
                <span className="flex items-center gap-2 text-xs text-foreground-muted">
                  <span className="status-dot" aria-hidden="true" />
                  Pending
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
}
