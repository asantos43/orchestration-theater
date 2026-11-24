// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInput, NotFound } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentService, isImage, mimeOf } from './attachments.js';
import { ANY_ATTACHMENT_ROOT } from './attachment-roots.js';

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let store: InMemoryStore;
let limits: { maxSize: number; readMax: number };
let service: AttachmentService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-attachments-'));
  const clock = new FakeClock();
  store = new InMemoryStore({ clock });
  await store.scenarios.create({
    id: 's1',
    kind: 'chat',
    flowId: 'chat',
    name: 's1',
    folder: root,
  });
  limits = { maxSize: 1024, readMax: 64 };
  service = new AttachmentService({
    store,
    roots: ANY_ATTACHMENT_ROOT,
    clock,
    scenariosDir: join(root, 'scenarios'),
    limits: () => limits,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function file(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

describe('mimeOf', () => {
  it('trusts the magic bytes over the name', () => {
    expect(mimeOf('photo.txt', PNG_HEAD)).toBe('image/png');
    expect(mimeOf('x.bin', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(mimeOf('x', Buffer.from('%PDF-1.7'))).toBe('application/pdf');
  });

  it('falls back to the extension, then to a look at the bytes', () => {
    expect(mimeOf('notes.md', Buffer.from('# hi'))).toBe('text/markdown');
    expect(mimeOf('README', Buffer.from('plain words'))).toBe('text/plain');
    expect(mimeOf('blob', Uint8Array.from([0, 1, 2, 3]))).toBe('application/octet-stream');
    // an image extension without image bytes is not an image
    expect(mimeOf('fake.png', Buffer.from('not an image'))).toBe('text/plain');
  });

  it('knows which types are images', () => {
    expect(isImage('image/webp')).toBe(true);
    expect(isImage('application/pdf')).toBe(false);
  });
});

describe('the attachment limit (scenarios.attachment_max_size)', () => {
  it('copies a file under the limit and numbers it A1, A2', async () => {
    const first = await service.addFile('s1', { path: await file('a.txt', 'hello') });
    const second = await service.addText('s1', { text: 'pasted' });
    expect([first.id, second.id]).toEqual(['A1', 'A2']);
    expect(first).toMatchObject({ source: 'copy', mime: 'text/plain', size: 5 });
    expect(first.path.startsWith(join(root, 'scenarios', 's1', 'attachments'))).toBe(true);
    expect(await readFile(first.path, 'utf8')).toBe('hello');
  });

  it('refuses a copy over the limit and says what to do', async () => {
    const big = await file('big.txt', 'x'.repeat(2000));
    await expect(service.addFile('s1', { path: big })).rejects.toThrow(/attachment_max_size/);
    await expect(service.addFile('s1', { path: big })).rejects.toBeInstanceOf(InvalidInput);
    await expect(service.addText('s1', { text: 'x'.repeat(2000) })).rejects.toThrow(
      /attachment_max_size/,
    );
    expect(await store.attachments.list('s1')).toEqual([]);
  });

  it('does not limit a reference, which copies nothing', async () => {
    const big = await file('big.txt', 'x'.repeat(2000));
    const record = await service.addFile('s1', { path: big, mode: 'reference' });
    // The reference keeps the real path (links followed): on macOS `/var` is `/private/var`, and on Windows
    // a short `RUNNER~1` name is the long one.
    expect(record).toMatchObject({ source: 'reference', path: await realpath(big), size: 2000 });
  });

  it('has no limit at 0', async () => {
    limits.maxSize = 0;
    const record = await service.addFile('s1', { path: await file('big.txt', 'x'.repeat(5000)) });
    expect(record.size).toBe(5000);
  });

  it('refuses a missing file, a folder and an unknown scenario', async () => {
    await expect(service.addFile('s1', { path: join(root, 'nope') })).rejects.toBeInstanceOf(
      InvalidInput,
    );
    await expect(service.addFile('s1', { path: root })).rejects.toBeInstanceOf(InvalidInput);
    await expect(service.addText('ghost', { text: 'x' })).rejects.toBeInstanceOf(NotFound);
  });

  it('writes scenario.attachment_added for each one', async () => {
    await service.addFile('s1', { path: await file('a.png', PNG_HEAD) });
    const events = (await store.events.readFrom(0, 100)).filter(
      (event) => event.type === 'scenario.attachment_added',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ attachmentId: 'A1', mime: 'image/png' });
  });
});

describe('read', () => {
  it('returns text as utf8 and cuts it at attachment_read_max', async () => {
    const small = await service.addText('s1', { text: 'short' });
    expect(await service.read(small)).toMatchObject({
      kind: 'text',
      encoding: 'utf8',
      content: 'short',
      truncated: false,
    });
    const long = await service.addText('s1', { text: 'y'.repeat(100), name: 'long.txt' });
    const read = await service.read(long);
    expect(read.content).toHaveLength(64);
    expect(read.truncated).toBe(true);
  });

  it('returns an image as base64 and refuses one over the read cap', async () => {
    const image = await service.addFile('s1', { path: await file('a.png', PNG_HEAD) });
    const read = await service.read(image);
    expect(read).toMatchObject({ kind: 'image', encoding: 'base64', mime: 'image/png' });
    expect(Buffer.from(read.content, 'base64')).toEqual(Buffer.from(PNG_HEAD));
    limits.readMax = 4;
    await expect(service.read(image)).rejects.toBeInstanceOf(InvalidInput);
  });

  it('reports a file that is gone, and an unknown id', async () => {
    const record = await service.addFile('s1', {
      path: await file('r.txt', 'x'),
      mode: 'reference',
    });
    await rm(record.path);
    await expect(service.read(record)).rejects.toBeInstanceOf(NotFound);
    await expect(service.get('s1', 'A9')).rejects.toBeInstanceOf(NotFound);
  });
});
