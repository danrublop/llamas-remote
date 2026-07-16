// A live dashboard of this Mac's stats (CPU / memory / load / uptime). Data comes from the main
// process via the `system:stats` IPC (Node `os`), polled here every 1.5s. All values reach the DOM
// as React children (textContent) — nothing untrusted, nothing as HTML.

import React, { useEffect, useState } from 'react';
import type { SystemStats } from '../../main/preload-notebook';

interface SysApi { systemStats: () => Promise<SystemStats> }
function api(): SysApi { return (window as unknown as { notebookAPI: SysApi }).notebookAPI; }

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
function rate(bps: number): string {
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', `${m}m`].filter(Boolean).join(' ');
}
// Green → amber → red as a load metric climbs.
const heat = (pct: number) => (pct < 60 ? '#10b981' : pct < 85 ? '#f59e0b' : '#ef4444');

// No width/height on the svg — the viewBox scales it to whatever width the row can spare.
function Ring({ pct, label, sub }: { pct: number; label: string; sub: string }) {
  const r = 52, c = 2 * Math.PI * r;
  return (
    <div className="dash-tile">
      <svg viewBox="0 0 120 120" className="dash-ring-svg">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--hairline-soft)" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={heat(pct)} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 60 60)" />
        <text x="60" y="58" textAnchor="middle" className="dash-ring-num">{pct}%</text>
        <text x="60" y="76" textAnchor="middle" className="dash-ring-lbl">{label}</text>
      </svg>
      <div className="dash-ring-sub">{sub}</div>
    </div>
  );
}

export default function SystemDashboard() {
  const [s, setS] = useState<SystemStats | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api().systemStats().then((v) => { if (alive) setS(v); }).catch(() => {});
    poll();
    const t = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!s) return <div className="dash dash--loading">Reading system stats…</div>;

  const memPct = s.memTotal ? Math.round((s.memUsed / s.memTotal) * 100) : 0;
  // Defensive: main and renderer are built separately, so a running main can be older than this
  // bundle and send a payload without the newest field. Missing data should show nothing, not
  // blank the whole window — there's no error boundary above this.
  const apps = s.topApps ?? [];
  return (
    <div className="dash">
      {/* Three tiles on one line — two circles and a square — that shrink together rather than wrap. */}
      <div className="dash-top">
        <Ring pct={s.cpu} label="CPU" sub={s.cpuModel} />
        <Ring pct={memPct} label="Memory" sub={`${gb(s.memUsed)} / ${gb(s.memTotal)} GB`} />
        <div className="dash-tile">
          <div className="dash-cores">
            {s.cores.map((p, i) => (
              <div key={i} className="dash-core" title={`Core ${i}: ${p}%`}>
                <div className="dash-core-bar"><div className="dash-core-fill" style={{ height: `${p}%`, background: heat(p) }} /></div>
                <div className="dash-core-lbl">{p}</div>
              </div>
            ))}
          </div>
          <div className="dash-ring-sub">Cores ({s.cores.length})</div>
        </div>
      </div>

      {apps.length > 0 && (
        <div className="dash-card">
          <div className="dash-card-title">Busiest apps <span className="dash-dim">· % of a core</span></div>
          {apps.map((a) => (
            <div key={a.name} className="dash-app">
              <span className="dash-app-name" title={a.name}>{a.name}</span>
              {/* Bars are relative to the busiest process: one can exceed 100% of a core. */}
              <span className="dash-app-track"><span className="dash-app-fill" style={{ width: `${(a.cpu / (apps[0].cpu || 1)) * 100}%`, background: heat(Math.min(a.cpu, 100)) }} /></span>
              <span className="dash-app-cpu">{a.cpu}%</span>
            </div>
          ))}
        </div>
      )}

      <div className="dash-stats">
        <div className="dash-stat"><span className="dash-k">Network ↓</span><span className="dash-v">{rate(s.rxRate)}</span></div>
        <div className="dash-stat"><span className="dash-k">Network ↑</span><span className="dash-v">{rate(s.txRate)}</span></div>
        <div className="dash-stat"><span className="dash-k">Load avg</span><span className="dash-v">{s.load.map((l) => l.toFixed(2)).join('  ')}</span></div>
        <div className="dash-stat"><span className="dash-k">Uptime</span><span className="dash-v">{fmtUptime(s.uptime)}</span></div>
        {s.gpu && <div className="dash-stat"><span className="dash-k">GPU</span><span className="dash-v">{s.gpu}</span></div>}
        <div className="dash-stat"><span className="dash-k">Host</span><span className="dash-v">{s.hostname}</span></div>
        <div className="dash-stat"><span className="dash-k">System</span><span className="dash-v">{s.platform} {s.arch} · {s.release}</span></div>
      </div>
    </div>
  );
}
