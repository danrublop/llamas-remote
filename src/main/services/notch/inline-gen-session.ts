// InlineGenerationSession: owns concurrent inline AI-block generations in the notebook.
//
// The panel's StreamSession has ONE active run (a newer query supersedes the older one —
// correct for the single streaming pane). Inline `/` generations are different: each targets
// its OWN AI block (by blockId), so generating in block A must NOT abort block B, and neither
// must abort a panel query. Sharing one StreamSession caused exactly that — any second
// generation aborted the first and left its block spinning in 'generating' forever, because
// the terminal event for a superseded run is dropped.
//
// This session keeps one in-flight run PER blockId:
//   - begin(blockId) aborts only THIS block's prior run (a re-run supersedes itself) and
//     returns a fresh runId + AbortSignal.
//   - emit() delivers an event only while its run is still the active one for that block, so
//     a superseded run's late tokens/terminal can't touch the block that replaced it.
//   - A superseded run needs no terminal event: the re-run that replaced it already put the
//     block back into 'generating' and will deliver its own terminal, so the block is never
//     stuck.
//
// Side effects go through the injected `send`, so it's unit-testable with no Electron.

export interface InlineGenSessionDeps {
  /** Deliver an event to the notebook renderer (no-op if the window is gone). */
  send: (channel: string, payload?: unknown) => void;
  /** Unique run id generator (randomUUID in production). */
  newId: () => string;
}

interface Run {
  runId: string;
  controller: AbortController;
}

export class InlineGenerationSession {
  private readonly runs = new Map<string, Run>(); // blockId -> its single in-flight run

  constructor(private readonly deps: InlineGenSessionDeps) {}

  /**
   * Start (or re-run) generation for a block. Aborts any prior in-flight run for THIS block
   * only, then returns the id to tag events with and the signal to hand the LLM client.
   */
  begin(blockId: string): { runId: string; signal: AbortSignal } {
    this.runs.get(blockId)?.controller.abort(); // re-run supersedes this block's own prior run
    const runId = this.deps.newId();
    const controller = new AbortController();
    this.runs.set(blockId, { runId, controller });
    return { runId, signal: controller.signal };
  }

  /** Emit an event, but only while `runId` is still the active run for `blockId`. A run
   *  superseded by a re-run is silently dropped (the re-run owns the block now). */
  emit(blockId: string, runId: string, channel: string, payload?: unknown): void {
    if (this.runs.get(blockId)?.runId !== runId) return;
    this.deps.send(channel, payload);
  }

  /** Finish a run (success or error). Releases the block's slot only if this run still owns
   *  it — a superseded run must not clear the re-run that replaced it. */
  end(blockId: string, runId: string): void {
    if (this.runs.get(blockId)?.runId === runId) this.runs.delete(blockId);
  }

  /** Abort every in-flight inline generation (notebook window closed / reloaded). */
  abortAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
    this.runs.clear();
  }
}
