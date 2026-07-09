// StreamSession: owns the lifecycle of streaming a query's answer into the notebook window.
//
// Solves three runtime hazards that used to live (untested) in main.ts:
//
//   1. READINESS  — the notebook window is created hidden and loads async. Events sent
//      before the renderer mounts its listeners are lost. We buffer notebook:* events
//      until the renderer signals ready, then flush. A reload re-buffers (markNotReady).
//
//   2. SUPERSEDE  — firing query B while A still streams used to let A's late tokens
//      overwrite B's editor. Each run gets an id; only the current run's events pass.
//      Beginning a new run drops the previous run's queued + future events.
//
//   3. ABORT      — a superseded or window-closed run should stop generating, not keep
//      an axios stream alive for minutes. Each run carries an AbortSignal.
//
// Side effects go through the injected `send` so the whole thing is unit-testable with no
// Electron. Note: collapsing the panel is NOT an abort — the answer streams into the
// separate notebook window, which stays open. Abort triggers are supersede + window close.
//
//   beginRun() ──▶ runId + signal ──▶ controller.runQuery(signal)
//       │                                   │
//       │  emit(runId, 'notebook:token')  ◀─┘ (dropped if a newer run began)
//       ▼
//   ready? ──no──▶ queue ──(markReady)──▶ flush current run's events ──▶ send()
//       └──yes──────────────────────────────────────────────────────▶ send()

export interface StreamSessionDeps {
  /** Deliver an event to the renderer (no-op if the window is gone). */
  send: (channel: string, payload?: unknown) => void;
  /** Unique run id generator (randomUUID in production). */
  newId: () => string;
}

interface QueuedEvent {
  runId: string;
  channel: string;
  payload: unknown;
}

export class StreamSession {
  private ready = false;
  private queue: QueuedEvent[] = [];
  private currentRunId: string | null = null;
  // True once the current run has finished. We keep `currentRunId` set (so a completed run's
  // already-queued trailing done/saved still flush when the renderer mounts late), but block
  // any NEW emit for the finished run — defends against a stray late token from a not-yet-GC'd
  // provider stream landing in the editor after the run is over.
  private currentRunEnded = false;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: StreamSessionDeps) {}

  /** Renderer mounted and listening — flush the current run's buffered events. */
  markReady(): void {
    this.ready = true;
    const pending = this.queue.filter((e) => e.runId === this.currentRunId);
    this.queue = [];
    for (const e of pending) this.deps.send(e.channel, e.payload);
  }

  /** Renderer navigated/reloaded — buffer again until the next markReady. */
  markNotReady(): void {
    this.ready = false;
  }

  /**
   * Start a new run. Aborts + invalidates the previous active run so its in-flight
   * stream stops and its trailing events are dropped. Returns the id to tag events with
   * and the signal to hand the LLM client.
   */
  beginRun(): { runId: string; signal: AbortSignal } {
    this.abortActive();
    const runId = this.deps.newId();
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.currentRunId = runId;
    this.currentRunEnded = false;
    return { runId, signal: controller.signal };
  }

  /**
   * Emit an event for a run. Dropped if the run was superseded/aborted; buffered if the
   * renderer isn't ready yet; otherwise sent immediately.
   */
  emit(runId: string, channel: string, payload?: unknown): void {
    if (runId !== this.currentRunId) return; // superseded or aborted — drop
    if (this.currentRunEnded) return; // run already finished — drop stray late callbacks
    if (this.ready) this.deps.send(channel, payload);
    else this.queue.push({ runId, channel, payload });
  }

  /** Finish a run (success or error). Releases its controller and marks the run ended so no
   *  new event can be emitted for it; leaves currentRunId set so trailing done/saved that
   *  were already emitted (and possibly queued) still flush until a newer run begins. */
  endRun(runId: string): void {
    this.controllers.delete(runId);
    if (runId === this.currentRunId) this.currentRunEnded = true;
  }

  /** Abort the active run (a newer run is starting, or the notebook window closed). */
  abortActive(): void {
    const aborted = this.currentRunId;
    if (!aborted) return;
    this.controllers.get(aborted)?.abort();
    this.controllers.delete(aborted);
    this.currentRunId = null;
    this.queue = this.queue.filter((e) => e.runId !== aborted);
  }
}
