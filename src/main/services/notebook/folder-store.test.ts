// Tests for the folder manifest (organization layer). folders.json is pure metadata beside
// the flat .md notes; a bug here scrambles the sidebar tree or note→folder assignments but
// never touches note CONTENT. Covered: create/rename/delete-with-reparent, note moves, the
// move-folder cycle guard, id validation, and load-time sanitization of a corrupt manifest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FolderStore, isValidFolderId } from './folder-store';

let dir: string;
let file: string;
let counter: number;
const nextId = () => `f${++counter}`;
const make = () => new FolderStore(file, nextId);

beforeEach(() => {
  counter = 0;
  dir = mkdtempSync(join(tmpdir(), 'lr-folders-'));
  file = join(dir, 'folders.json');
});
afterEach(() => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('isValidFolderId', () => {
  it('accepts server-shaped ids and rejects everything else', () => {
    expect(isValidFolderId('f1')).toBe(true);
    expect(isValidFolderId('A_b-9')).toBe(true);
    expect(isValidFolderId('../etc')).toBe(false);
    expect(isValidFolderId('has space')).toBe(false);
    expect(isValidFolderId('')).toBe(false);
    expect(isValidFolderId(42)).toBe(false);
    expect(isValidFolderId(null)).toBe(false);
  });
});

describe('createFolder', () => {
  it('creates a root folder and persists it', () => {
    const s = make();
    const f = s.createFolder('Work', null);
    expect(f).toEqual({ id: 'f1', name: 'Work', parentId: null });
    expect(s.getState().folders).toEqual([f]);
    // persisted to disk
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.folders).toEqual([f]);
  });

  it('nests under an existing parent', () => {
    const s = make();
    const parent = s.createFolder('Work', null);
    const child = s.createFolder('Reports', parent.id);
    expect(child.parentId).toBe(parent.id);
  });

  it('throws on an unknown parent (renderer-supplied garbage is inert)', () => {
    const s = make();
    expect(() => s.createFolder('Orphan', 'nope')).toThrow();
  });

  it('defaults a blank/whitespace name to "New Folder"', () => {
    const s = make();
    expect(s.createFolder('   ', null).name).toBe('New Folder');
    expect(s.createFolder('', null).name).toBe('New Folder');
  });
});

describe('renameFolder', () => {
  it('renames an existing folder', () => {
    const s = make();
    const f = s.createFolder('Work', null);
    s.renameFolder(f.id, 'Personal');
    expect(s.getState().folders[0].name).toBe('Personal');
  });

  it('ignores an empty new name (keeps the old one) and unknown ids', () => {
    const s = make();
    const f = s.createFolder('Work', null);
    s.renameFolder(f.id, '   ');
    expect(s.getState().folders[0].name).toBe('Work');
    expect(() => s.renameFolder('ghost', 'x')).not.toThrow();
  });
});

describe('deleteFolder (reparent up, lose nothing)', () => {
  it('reparents child folders and notes UP to the deleted folder parent', () => {
    const s = make();
    const a = s.createFolder('A', null);
    const b = s.createFolder('B', a.id); // A > B
    const c = s.createFolder('C', b.id); // A > B > C
    s.moveNote('note-in-b', b.id);
    s.deleteFolder(b.id);
    const st = s.getState();
    expect(st.folders.find((f) => f.id === b.id)).toBeUndefined();
    // C's parent collapses from B up to A
    expect(st.folders.find((f) => f.id === c.id)?.parentId).toBe(a.id);
    // note reassigns from B up to A
    expect(st.assignments['note-in-b']).toBe(a.id);
  });

  it('drops note assignments to root when deleting a top-level folder', () => {
    const s = make();
    const a = s.createFolder('A', null);
    s.moveNote('n1', a.id);
    s.deleteFolder(a.id);
    // parentId was null -> assignment removed entirely (note lives at root)
    expect(s.getState().assignments['n1']).toBeUndefined();
  });

  it('is a no-op for an unknown id', () => {
    const s = make();
    s.createFolder('A', null);
    s.deleteFolder('ghost');
    expect(s.getState().folders).toHaveLength(1);
  });
});

describe('moveNote / forgetNote', () => {
  it('assigns and clears a note assignment', () => {
    const s = make();
    const a = s.createFolder('A', null);
    s.moveNote('n1', a.id);
    expect(s.getState().assignments['n1']).toBe(a.id);
    s.moveNote('n1', null); // back to root
    expect(s.getState().assignments['n1']).toBeUndefined();
  });

  it('ignores a move into an unknown folder', () => {
    const s = make();
    s.moveNote('n1', 'ghost');
    expect(s.getState().assignments['n1']).toBeUndefined();
  });

  it('forgetNote removes the assignment (note deleted for good)', () => {
    const s = make();
    const a = s.createFolder('A', null);
    s.moveNote('n1', a.id);
    s.forgetNote('n1');
    expect(s.getState().assignments['n1']).toBeUndefined();
  });
});

describe('moveFolder (cycle guard)', () => {
  it('reparents a folder under a new parent', () => {
    const s = make();
    const a = s.createFolder('A', null);
    const b = s.createFolder('B', null);
    s.moveFolder(b.id, a.id);
    expect(s.getState().folders.find((f) => f.id === b.id)?.parentId).toBe(a.id);
  });

  it('rejects moving a folder into itself', () => {
    const s = make();
    const a = s.createFolder('A', null);
    s.moveFolder(a.id, a.id);
    expect(s.getState().folders.find((f) => f.id === a.id)?.parentId).toBeNull();
  });

  it('rejects moving a folder into its own descendant (cycle)', () => {
    const s = make();
    const a = s.createFolder('A', null);
    const b = s.createFolder('B', a.id); // A > B
    const c = s.createFolder('C', b.id); // A > B > C
    s.moveFolder(a.id, c.id); // would make A a child of its descendant
    expect(s.getState().folders.find((f) => f.id === a.id)?.parentId).toBeNull();
  });

  it('ignores an unknown target parent and unknown folder', () => {
    const s = make();
    const a = s.createFolder('A', null);
    s.moveFolder(a.id, 'ghost');
    expect(s.getState().folders.find((f) => f.id === a.id)?.parentId).toBeNull();
    expect(() => s.moveFolder('ghost', a.id)).not.toThrow();
  });
});

describe('load / persistence', () => {
  it('round-trips state across a reload from disk', () => {
    const s = make();
    const a = s.createFolder('A', null);
    s.moveNote('n1', a.id);
    const reloaded = new FolderStore(file, nextId);
    expect(reloaded.getState()).toEqual({ folders: [a], assignments: { n1: a.id } });
  });

  it('sanitizes a corrupt manifest: drops invalid folders and dangling assignments', () => {
    writeFileSync(
      file,
      JSON.stringify({
        folders: [
          { id: 'good', name: 'Good', parentId: null },
          { id: 'bad id', name: 'Bad', parentId: null }, // invalid id
          { id: 'noname', parentId: null }, // missing name
        ],
        assignments: { n1: 'good', n2: 'ghost' }, // n2 points at a non-existent folder
      }),
      'utf8',
    );
    const s = new FolderStore(file, nextId);
    const st = s.getState();
    expect(st.folders.map((f) => f.id)).toEqual(['good']);
    expect(st.assignments).toEqual({ n1: 'good' });
  });

  it('starts empty on unparseable JSON', () => {
    writeFileSync(file, 'not json at all', 'utf8');
    const s = new FolderStore(file, nextId);
    expect(s.getState()).toEqual({ folders: [], assignments: {} });
  });

  it('reparents a folder with an orphaned parentId to root', () => {
    writeFileSync(
      file,
      JSON.stringify({
        folders: [{ id: 'child', name: 'Child', parentId: 'ghost' }], // parent never existed
        assignments: {},
      }),
      'utf8',
    );
    const s = new FolderStore(file, nextId);
    expect(s.getState().folders).toEqual([{ id: 'child', name: 'Child', parentId: null }]);
  });

  it('breaks a cycle in a hand-edited manifest without hanging', () => {
    writeFileSync(
      file,
      JSON.stringify({
        folders: [
          { id: 'a', name: 'A', parentId: 'b' },
          { id: 'b', name: 'B', parentId: 'a' }, // a→b→a cycle
        ],
        assignments: {},
      }),
      'utf8',
    );
    const s = new FolderStore(file, nextId);
    const roots = s.getState().folders.filter((f) => f.parentId === null);
    // At least one node detached to root so the tree is acyclic…
    expect(roots.length).toBeGreaterThanOrEqual(1);
    // …and a subsequent moveFolder over the (now-normalized) tree returns instead of looping.
    expect(() => s.moveFolder('a', 'b')).not.toThrow();
  });
});
