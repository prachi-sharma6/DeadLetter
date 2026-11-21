import { useEffect, useState } from 'react';

interface Health {
  status: 'ok' | 'degraded';
  version: string;
  checks: Record<string, { ok: boolean; latencyMs: number }>;
  workers: number | null;
}

// Phase 0 shell: proves the build, same-origin serving and the API round trip. The dashboard arrives in Phase 5.
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/health', { signal: ctrl.signal })
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: Error) => e.name !== 'AbortError' && setError('API unreachable'));
    return () => ctrl.abort();
  }, []);

  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">DeadLetter</h1>
        <p className="mt-2 text-muted">Monitor, inspect and recover failed background jobs.</p>
      </div>
      <section aria-labelledby="status" className="rounded-lg border border-line bg-panel p-4">
        <h2 id="status" className="text-sm font-medium text-muted">
          System status
        </h2>
        {error && <p className="mt-2 text-bad">{error}</p>}
        {!error && !health && <p className="mt-2 text-muted">Checking…</p>}
        {health && (
          <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
            <dt className="text-muted">Overall</dt>
            <dd className={health.status === 'ok' ? 'text-ok' : 'text-bad'}>{health.status}</dd>
            {Object.entries(health.checks).map(([name, c]) => (
              <div key={name} className="contents">
                <dt className="text-muted capitalize">{name}</dt>
                <dd className={c.ok ? 'text-ok' : 'text-bad'}>{c.ok ? `up (${c.latencyMs} ms)` : 'down'}</dd>
              </div>
            ))}
            <dt className="text-muted">Workers</dt>
            <dd>{health.workers ?? 'unknown'}</dd>
            <dt className="text-muted">Version</dt>
            <dd className="font-mono">{health.version.slice(0, 7)}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
