// AI-block sidecar: structured metadata for the AI blocks inside a note.
//
// Truth model (locked in the 2026-05-26 eng review): a note's human-readable PROSE is
// canonical Markdown in `<id>.md`; its AI-block STRUCTURE (which prompt/model produced a
// block, for re-run) lives in a sidecar `<id>.meta.json`. The two are bound by a stable,
// invisible anchor the serializer emits in the Markdown — `<!--ai:<blockId>-->` on its own
// line above the block. The `.md` stays clean and openable anywhere; the sidecar only
// ENRICHES blocks that still exist in the prose.
//
// Reconcile rules (so external edits to the `.md` can't corrupt state):
//   anchor in .md + meta in sidecar .... LIVE   (block keeps its prompt/model)
//   anchor in .md, no meta ............. plain block (rendered as ordinary prose)
//   meta in sidecar, anchor gone ....... ORPHAN (dropped — prose deletion wins)
//
//   <id>.md  ──parseAnchorIds──▶ [blockId…] ─┐
//                                            ├─ reconcileSidecar ─▶ { live, orphaned }
//   <id>.meta.json ──readSidecar──▶ [meta…] ─┘

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';

/** Metadata for one AI block, keyed by the anchor id embedded in the Markdown. */
export interface AIBlockMeta {
  blockId: string;
  /** The prompt that produced this block (for re-run + audit). */
  prompt: string;
  /** Model id used (persisted so re-run reuses it). */
  model: string;
  /** Slash-command (preset) id, if the block came from a `/` command — for cross-session re-run. */
  commandId?: string;
  /** The text the command ran on — persisted so a re-run after reload reuses the same input. */
  selection?: string;
  /** ISO timestamp the block was generated. */
  createdAt: string;
}

export interface SidecarFile {
  version: 1;
  blocks: AIBlockMeta[];
}

const ANCHOR_RE = /<!--\s*ai:([a-zA-Z0-9_-]+)\s*-->/g;
const BLOCK_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_FIELD = 100_000; // cap a field so a runaway selection can't bloat the sidecar

/**
 * Coerce untrusted renderer-supplied AI-block metadata into safe, well-typed entries before
 * it's written to disk. Drops anything without a valid blockId, dedups repeated blockIds
 * (copy/paste of a block yields two nodes sharing one id — keep the first), and caps string
 * fields. `createdAt` is intentionally NOT accepted here; the store fills/preserves it.
 */
export function sanitizeIncomingBlocks(input: unknown): Array<Omit<AIBlockMeta, 'createdAt'>> {
  if (!Array.isArray(input)) return [];
  const out: Array<Omit<AIBlockMeta, 'createdAt'>> = [];
  const seen = new Set<string>();
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, MAX_FIELD) : undefined);
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    const blockId = b.blockId;
    if (typeof blockId !== 'string' || !BLOCK_ID_RE.test(blockId) || seen.has(blockId)) continue;
    seen.add(blockId);
    out.push({
      blockId,
      prompt: str(b.prompt) ?? '',
      model: str(b.model) ?? '',
      commandId: str(b.commandId),
      selection: str(b.selection),
    });
  }
  return out;
}

/**
 * Extract AI-block anchor ids from a Markdown body, in document order. Tolerant of
 * surrounding whitespace; ignores anything that isn't a well-formed `<!--ai:ID-->`.
 */
export function parseAnchorIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const m of markdown.matchAll(ANCHOR_RE)) ids.push(m[1]);
  return ids;
}

export interface SidecarReconcile {
  /** Meta whose block still exists in the prose, ordered to match the Markdown anchors. */
  live: AIBlockMeta[];
  /** blockIds whose meta no longer has a matching anchor (prose deleted) — to be dropped. */
  orphaned: string[];
}

/**
 * Reconcile the Markdown's anchors against the sidecar's metadata. The prose is
 * authoritative for EXISTENCE: meta with no matching anchor is orphaned (dropped), and the
 * survivors are returned in anchor (document) order. Anchors with no meta simply have no
 * entry here — the editor renders them as plain blocks.
 */
export function reconcileSidecar(anchorIds: readonly string[], meta: readonly AIBlockMeta[]): SidecarReconcile {
  const byId = new Map(meta.map((m) => [m.blockId, m]));
  const live: AIBlockMeta[] = [];
  const seen = new Set<string>();
  for (const id of anchorIds) {
    const m = byId.get(id);
    if (m && !seen.has(id)) {
      live.push(m);
      seen.add(id);
    }
  }
  const orphaned = meta.filter((m) => !seen.has(m.blockId)).map((m) => m.blockId);
  return { live, orphaned };
}

function sidecarPath(dir: string, id: string): string {
  return join(dir, `${id}.meta.json`);
}

/** Read a note's sidecar, or null if absent/unreadable/malformed (treated as no metadata). */
export function readSidecar(dir: string, id: string): SidecarFile | null {
  const path = sidecarPath(dir, id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SidecarFile;
    if (!parsed || !Array.isArray(parsed.blocks)) return null;
    return { version: 1, blocks: parsed.blocks.filter((b) => b && typeof b.blockId === 'string') };
  } catch {
    return null;
  }
}

/**
 * Write a note's sidecar atomically (temp file + rename), or delete it when there are no
 * blocks (a note with no AI blocks should not leave an empty sidecar behind).
 */
export function writeSidecar(dir: string, id: string, blocks: AIBlockMeta[]): void {
  const path = sidecarPath(dir, id);
  if (blocks.length === 0) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const file: SidecarFile = { version: 1, blocks };
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, path);
}
