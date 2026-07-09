import { describe, it, expect, vi } from 'vitest';
import { NotchController, type LlmClient, type NotchControllerDeps } from './notch-controller';
import { BUILT_IN_PRESETS } from '../presets/presets';
import type { NotebookEntry } from '../notebook/types';

function setup(over: Partial<NotchControllerDeps> = {}) {
  const saved: NotebookEntry[] = [];
  const llm: LlmClient = {
    generate: vi.fn(async (opts) => {
      opts.onToken?.('partial');
      return `answer for ${opts.model}`;
    }),
  };
  const deps: NotchControllerDeps = {
    llm,
    notebook: { save: (e) => saved.push(e) },
    routerConfig: { defaultTextModel: 'llama3.2', visionModel: 'llava' },
    presets: BUILT_IN_PRESETS,
    newId: () => 'id-1',
    now: () => '2026-05-25T00:00:00Z',
    ...over,
  };
  return { controller: new NotchController(deps), saved, llm };
}

describe('NotchController.runQuery', () => {
  it('runs a preset query: builds the prompt, routes the model, persists the answer', async () => {
    const { controller, saved, llm } = setup();
    const res = await controller.runQuery({
      kind: 'text',
      presetId: 'explain',
      capture: { text: 'const x = 1', sourceApp: 'VSCode', via: 'clipboard' },
      language: 'javascript',
    });

    expect(res.answer).toBe('answer for llama3.2');
    expect(res.model).toBe('llama3.2');
    // Prompt assembled from the Explain template + the selection.
    const promptArg = (llm.generate as any).mock.calls[0][0].prompt as string;
    expect(promptArg).toContain('Explain');
    expect(promptArg).toContain('const x = 1');
    // Persisted with tags from source app + language.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'id-1', model: 'llama3.2', sourceApp: 'VSCode', tags: ['VSCode', 'javascript'] });
  });

  it('routes image queries to the vision model and passes the image path', async () => {
    const { controller, llm } = setup();
    const res = await controller.runQuery({ kind: 'image', presetId: 'explain', imagePath: '/tmp/shot.png' });
    expect(res.model).toBe('llava');
    expect((llm.generate as any).mock.calls[0][0].imagePath).toBe('/tmp/shot.png');
  });

  it('supports freeform questions with no preset', async () => {
    const { controller, llm } = setup();
    await controller.runQuery({
      kind: 'text',
      freeText: 'what does this do?',
      capture: { text: 'foo()', sourceApp: 'Safari', via: 'clipboard' },
    });
    const prompt = (llm.generate as any).mock.calls[0][0].prompt as string;
    expect(prompt).toBe('what does this do?\n\nfoo()');
  });

  it('appends a typed follow-up to a preset prompt', async () => {
    const { controller, llm } = setup();
    await controller.runQuery({
      kind: 'text',
      presetId: 'explain',
      freeText: 'in one sentence',
      capture: { text: 'x', sourceApp: 'A', via: 'clipboard' },
    });
    const prompt = (llm.generate as any).mock.calls[0][0].prompt as string;
    expect(prompt.endsWith('in one sentence')).toBe(true);
  });

  it('folds attached files into the prompt under an "Attached files" header', async () => {
    const { controller, llm } = setup();
    await controller.runQuery({
      kind: 'text',
      freeText: 'summarize these',
      attachments: [
        { name: 'a.ts', content: 'export const a = 1;' },
        { name: 'b.md', content: '# Notes' },
      ],
    });
    const prompt = (llm.generate as any).mock.calls[0][0].prompt as string;
    expect(prompt).toContain('summarize these');
    expect(prompt).toContain('Attached files:');
    expect(prompt).toContain('--- a.ts ---');
    expect(prompt).toContain('export const a = 1;');
    expect(prompt).toContain('--- b.md ---');
  });

  it('treats attachments alone as valid input (no selection or question)', async () => {
    const { controller, llm } = setup();
    await controller.runQuery({
      kind: 'text',
      attachments: [{ name: 'log.txt', content: 'error on line 5' }],
    });
    const prompt = (llm.generate as any).mock.calls[0][0].prompt as string;
    expect(prompt.startsWith('Attached files:')).toBe(true);
    expect(prompt).toContain('error on line 5');
  });

  it('throws on empty input so the caller can show the paste/type state', async () => {
    const { controller, saved } = setup();
    await expect(controller.runQuery({ kind: 'text', capture: { text: '', via: 'none' } })).rejects.toThrow(/Nothing to ask/);
    expect(saved).toHaveLength(0);
  });

  it('throws Nothing-to-ask for a preset on an empty selection and never calls the llm', async () => {
    const { controller, saved, llm } = setup();
    // `/explain` at the top of an empty note: the preset renders its literal instruction
    // text, so the assembled prompt is non-empty — the guard must key off the user input.
    await expect(
      controller.runQuery({ kind: 'text', presetId: 'explain', capture: { text: '   ', via: 'clipboard' } }),
    ).rejects.toThrow(/Nothing to ask/);
    expect(llm.generate).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('falls back to the selection when freeText is an empty string', async () => {
    const { controller, llm } = setup();
    await controller.runQuery({
      kind: 'text',
      freeText: '',
      capture: { text: 'const x = 1', sourceApp: 'A', via: 'clipboard' },
    });
    const prompt = (llm.generate as any).mock.calls[0][0].prompt as string;
    expect(prompt).toBe('const x = 1'); // selection not discarded by empty freeText
  });

  it('accepts a bare image (no preset, no question) and passes it to the llm', async () => {
    const { controller, llm, saved } = setup();
    const res = await controller.runQuery({ kind: 'image', imagePath: '/tmp/shot.png' });
    expect(res.model).toBe('llava');
    expect((llm.generate as any).mock.calls[0][0].imagePath).toBe('/tmp/shot.png');
    expect(saved).toHaveLength(1);
  });

  it('rejects an unknown preset', async () => {
    const { controller } = setup();
    await expect(controller.runQuery({ kind: 'text', presetId: 'nope', capture: { text: 'x', via: 'clipboard' } })).rejects.toThrow(/Unknown preset/);
  });

  it('rejects a text-only preset used on an image', async () => {
    const { controller } = setup();
    await expect(controller.runQuery({ kind: 'image', presetId: 'rewrite', imagePath: '/tmp/s.png' })).rejects.toThrow(/does not accept image/);
  });

  it('persist:false streams + returns the answer but saves no entry (inline notebook generation)', async () => {
    const { controller, saved, llm } = setup();
    const tokens: string[] = [];
    const res = await controller.runQuery({
      kind: 'text',
      presetId: 'explain',
      persist: false,
      capture: { text: 'const x = 1', via: 'clipboard' },
      onToken: (d) => tokens.push(d),
    });
    expect(res.answer).toBe('answer for llama3.2');
    expect(res.model).toBe('llama3.2');
    expect(res.entry).toBeUndefined();
    expect(saved).toHaveLength(0); // no separate note created
    expect(tokens).toEqual(['partial']); // still streams
    expect((llm.generate as any).mock.calls[0][0].prompt).toContain('const x = 1');
  });
});
