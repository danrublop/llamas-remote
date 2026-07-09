// Folder manifest: the organization layer for the notebook.
//
// Notes stay flat `<id>.md` files (Markdown is the source of truth for CONTENT). Folders are
// pure organization metadata — a small `folders.json` manifest holding the folder tree plus a
// note→folder assignment map. Keeping this separate means the SQLite/FTS index and the
// Markdown-as-truth invariant are both untouched; the renderer joins the flat note list with
// this tree to draw the sidebar.
//
//   {
//     "folders":     [ { "id": "…", "name": "Work", "parentId": null }, … ],
//     "assignments": { "<noteId>": "<folderId>", … }   // notes absent here live at the root
//   }

import { existsSync, readFileSync, writeFileSync } from 'fs';

export interface Folder {
  id: string;
  name: string;
  parentId: string | null; // null = top level (the app root)
}

export interface FolderState {
  folders: Folder[];
  assignments: Record<string, string>; // noteId -> folderId
}

/** Folder ids are server-generated. Reject anything else so a renderer-supplied id is inert. */
export function isValidFolderId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export class FolderStore {
  private folders: Folder[] = [];
  private assignments: Record<string, string> = {};

  constructor(
    private readonly path: string,
    private readonly newId: () => string,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FolderState>;
      this.folders = Array.isArray(raw.folders)
        ? raw.folders.filter(
            (f): f is Folder =>
              !!f && isValidFolderId(f.id) && typeof f.name === 'string' &&
              (f.parentId === null || isValidFolderId(f.parentId)),
          )
        : [];
      this.normalizeTree(); // drop orphan parents + break any cycles from a hand-edited file
      const asg: Record<string, string> = {};
      if (raw.assignments && typeof raw.assignments === 'object') {
        for (const [noteId, folderId] of Object.entries(raw.assignments)) {
          if (typeof folderId === 'string' && this.folders.some((f) => f.id === folderId)) {
            asg[noteId] = folderId;
          }
        }
      }
      this.assignments = asg;
    } catch (e) {
      console.warn('folders.json unreadable; starting empty.', e);
      this.folders = [];
      this.assignments = {};
    }
  }

  /**
   * Guarantee the in-memory tree is acyclic with no dangling parents. The app's own
   * mutators preserve this, but folders.json can be hand-edited — an orphan parentId
   * would hide a folder, and a cycle (a→b→a) would make moveFolder's ancestry walk
   * loop forever, hanging the main process. Both are repaired by reparenting to root.
   */
  private normalizeTree(): void {
    const ids = new Set(this.folders.map((f) => f.id));
    for (const f of this.folders) {
      if (f.parentId !== null && !ids.has(f.parentId)) f.parentId = null; // orphan → root
    }
    for (const f of this.folders) {
      const seen = new Set<string>([f.id]);
      let cursor: string | null = f.parentId;
      while (cursor !== null) {
        if (seen.has(cursor)) { f.parentId = null; break; } // cycle: detach this node to root
        seen.add(cursor);
        cursor = this.folders.find((x) => x.id === cursor)?.parentId ?? null;
      }
    }
  }

  private save(): void {
    const state: FolderState = { folders: this.folders, assignments: this.assignments };
    try {
      writeFileSync(this.path, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      console.warn('failed to write folders.json:', e);
    }
  }

  getState(): FolderState {
    return { folders: [...this.folders], assignments: { ...this.assignments } };
  }

  /** Create a folder under `parentId` (null = root). Returns the new folder. */
  createFolder(name: string, parentId: string | null): Folder {
    const parent = parentId === null || parentId === undefined ? null : parentId;
    if (parent !== null && !this.folders.some((f) => f.id === parent)) {
      throw new Error(`Unknown parent folder: ${JSON.stringify(parentId)}`);
    }
    const folder: Folder = {
      id: this.newId(),
      name: (name || 'New Folder').trim() || 'New Folder',
      parentId: parent,
    };
    this.folders.push(folder);
    this.save();
    return folder;
  }

  renameFolder(id: string, name: string): void {
    const f = this.folders.find((x) => x.id === id);
    if (!f) return;
    f.name = (name || '').trim() || f.name;
    this.save();
  }

  /**
   * Delete a folder. Its immediate child folders and any notes assigned to it are reparented
   * UP to the deleted folder's parent — so nothing is lost, only that one level collapses.
   */
  deleteFolder(id: string): void {
    const target = this.folders.find((f) => f.id === id);
    if (!target) return;
    const newParent = target.parentId;
    for (const f of this.folders) {
      if (f.parentId === id) f.parentId = newParent;
    }
    for (const [noteId, folderId] of Object.entries(this.assignments)) {
      if (folderId === id) {
        if (newParent === null) delete this.assignments[noteId];
        else this.assignments[noteId] = newParent;
      }
    }
    this.folders = this.folders.filter((f) => f.id !== id);
    this.save();
  }

  /** Move a note into `folderId` (null = root). */
  moveNote(noteId: string, folderId: string | null): void {
    if (folderId === null || folderId === undefined) {
      delete this.assignments[noteId];
    } else {
      if (!this.folders.some((f) => f.id === folderId)) return;
      this.assignments[noteId] = folderId;
    }
    this.save();
  }

  /** Drop a note's assignment entirely (used when the note is deleted for good). */
  forgetNote(noteId: string): void {
    if (noteId in this.assignments) {
      delete this.assignments[noteId];
      this.save();
    }
  }

  /** Move a folder under `newParentId` (null = root). Rejects cycles (into itself/descendant). */
  moveFolder(id: string, newParentId: string | null): void {
    const folder = this.folders.find((f) => f.id === id);
    if (!folder) return;
    const parent = newParentId === null || newParentId === undefined ? null : newParentId;
    if (parent === id) return; // into itself
    if (parent !== null) {
      if (!this.folders.some((f) => f.id === parent)) return; // unknown target
      // Walk up from the target; if we reach `id`, the move would create a cycle.
      // The visited set is a safety net so a corrupt (already-cyclic) tree can't hang here.
      const seen = new Set<string>();
      let cursor: string | null = parent;
      while (cursor !== null) {
        if (cursor === id) return; // target is a descendant of the folder being moved
        if (seen.has(cursor)) return; // pre-existing cycle — refuse rather than loop
        seen.add(cursor);
        cursor = this.folders.find((f) => f.id === cursor)?.parentId ?? null;
      }
    }
    folder.parentId = parent;
    this.save();
  }
}
