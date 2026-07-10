// Drawing sidecar: the re-editable Excalidraw scene for each drawing in a note.
//
// Same truth model as the AI-block sidecar (sidecar.ts): the note's Markdown holds a viewable
// PNG (`![drawing](images/draw-<id>.png)`) plus an invisible `<!--draw:<id>-->` anchor; the
// re-editable scene JSON lives here in `<id>.draw.json`, keyed by drawingId. The prose is
// authoritative for EXISTENCE — a scene whose anchor is gone is pruned on the next save (the
// live doc rewrites this file from exactly the drawings still in it).
//
// The scene is opaque local user data — stored and returned verbatim, never executed.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';

export interface DrawingMeta {
  drawingId: string;
  /** Opaque Excalidraw scene ({ elements, files, ... }). Treated as data, never executed. */
  scene: unknown;
}

/** As sent from the renderer on save: scene to persist + (only when just drawn) the PNG bytes. */
export interface IncomingDrawing extends DrawingMeta {
  /** `data:image/png;base64,...` for the images/ file — present only when edited this session. */
  png?: string;
}

export interface DrawingSidecarFile {
  version: 1;
  drawings: DrawingMeta[];
}

const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_SCENE = 8_000_000; // ~8MB serialized scene cap (embedded images can be large)
const MAX_PNG = 12_000_000; // ~12MB data-URI cap
const PNG_PREFIX = 'data:image/png;base64,';

/**
 * Coerce untrusted renderer-supplied drawing payloads into safe entries. Drops anything
 * without a valid drawingId or a plain-object scene, dedups repeated ids (copy/paste of a
 * drawing yields two nodes sharing one id — keep the first), and caps serialized sizes. The
 * PNG is passed through only when it's a well-formed base64 PNG data URI under the cap.
 */
export function sanitizeIncomingDrawings(input: unknown): IncomingDrawing[] {
  if (!Array.isArray(input)) return [];
  const out: IncomingDrawing[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    const id = d.drawingId;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
    const scene = d.scene;
    if (!scene || typeof scene !== 'object') continue;
    try { if (JSON.stringify(scene).length > MAX_SCENE) continue; } catch { continue; }
    const png = d.png;
    const validPng = typeof png === 'string' && png.startsWith(PNG_PREFIX) && png.length <= MAX_PNG ? png : undefined;
    seen.add(id);
    out.push({ drawingId: id, scene, png: validPng });
  }
  return out;
}

function sidecarPath(dir: string, id: string): string {
  return join(dir, `${id}.draw.json`);
}

/** Read a note's drawing sidecar, or null if absent/unreadable/malformed. */
export function readDrawingSidecar(dir: string, id: string): DrawingSidecarFile | null {
  const path = sidecarPath(dir, id);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DrawingSidecarFile;
    if (!parsed || !Array.isArray(parsed.drawings)) return null;
    return { version: 1, drawings: parsed.drawings.filter((d) => d && typeof d.drawingId === 'string' && d.scene) };
  } catch {
    return null;
  }
}

/** Write a note's drawing sidecar atomically, or delete it when there are no drawings. */
export function writeDrawingSidecar(dir: string, id: string, drawings: DrawingMeta[]): void {
  const path = sidecarPath(dir, id);
  if (drawings.length === 0) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // Persist scene only — the PNG lives as a real file in images/, not here.
  const file: DrawingSidecarFile = { version: 1, drawings: drawings.map((d) => ({ drawingId: d.drawingId, scene: d.scene })) };
  writeFileSync(tmp, JSON.stringify(file), 'utf8');
  renameSync(tmp, path);
}
