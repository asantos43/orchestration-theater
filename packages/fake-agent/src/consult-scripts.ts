// SPDX-License-Identifier: MPL-2.0
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * [proposta] What the fake Consultant of a chat does (P10, N86), beyond reading the attachments.
 * The question of the Director is also the script: each word of the form `<verb>:<argument>` is a
 * thing the Consultant does before it answers, and what it did goes in the answer.
 *
 * - `write:<path>=<text>`: writes `<text>` (`_` is a space) at `<path>` in its working directory,
 *   the worktree of the consultation. A path that leaves the directory is refused, as a client
 *   refuses it, and the answer says `refused`.
 * - `link:<name>=<target>`: creates a symlink `<name>` to `<target>` (an absolute path outside the
 *   directory, say). A client would not do that on its own: the point is to put into the worktree
 *   what the daemon must refuse to carry into the chat folder.
 * - `http:<url>`: calls `http_get`; the answer carries the status and the start of the body, or
 *   `refused` when the role has no such tool.
 *
 * An image attachment is read with `read_attachment`; the answer says how many bytes of image the
 * reply carried as an `image` block (what a client with vision would be shown).
 */

/** What the Consultant needs of its host (the `RolePlayHost` of the role-play fits it). */
export interface ConsultHost {
  readonly cwd: string;
  call(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{
    isError: boolean;
    text: string;
    structured: unknown;
    images?: readonly { readonly mimeType: string; readonly bytes: number }[];
  }>;
}

type Call = ConsultHost['call'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `path` under `cwd`, or `undefined` when it lands outside (what the fake agent's own tools do). */
async function insideCwd(cwd: string, path: string): Promise<string | undefined> {
  const root = await realpath(cwd);
  const target = resolve(root, path);
  if (target === root || !within(root, target)) return undefined;
  return target;
}

async function writeIn(cwd: string, path: string, text: string): Promise<string> {
  const target = await insideCwd(cwd, path);
  if (target === undefined) return `write ${path} refused`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text.replaceAll('_', ' '));
  return `write ${path} ok`;
}

async function linkIn(cwd: string, name: string, to: string): Promise<string> {
  const target = await insideCwd(cwd, name);
  if (target === undefined) return `link ${name} refused`;
  await mkdir(dirname(target), { recursive: true });
  await symlink(to, target);
  return `link ${name} ok`;
}

async function getHttp(call: Call, url: string): Promise<string> {
  try {
    const reply = await call('http_get', { url });
    if (reply.isError || !isRecord(reply.structured)) return `http ${url} refused`;
    const { status, body } = reply.structured;
    const start = typeof body === 'string' ? body.trim().slice(0, 80) : '';
    return `http ${url} ${String(status)} ${start}`.trim();
  } catch {
    return `http ${url} refused`;
  }
}

async function readAttachment(call: Call, id: string): Promise<string> {
  const reply = await call('read_attachment', { id });
  if (reply.isError || !isRecord(reply.structured)) return `${id} refused`;
  const { mime, kind, content } = reply.structured;
  if (kind === 'text' && typeof content === 'string') return `${id} says ${content.trim()}`;
  const image = reply.images?.[0];
  if (image !== undefined) {
    return `${id} is ${String(mime)}, seen as ${image.mimeType} (${String(image.bytes)} bytes)`;
  }
  return `${id} is ${String(mime)}`;
}

/** The answer of the fake Consultant: what it found in the attachments and what its directives did. */
export async function consultAnswer(
  host: ConsultHost,
  question: string,
  attachments: readonly string[],
): Promise<string> {
  const found: string[] = [];
  for (const id of attachments)
    found.push(await readAttachment((tool, args) => host.call(tool, args), id));
  for (const word of question.split(/\s+/)) {
    const toWrite = /^write:([^=]+)=(.*)$/.exec(word);
    if (toWrite !== null) {
      found.push(await writeIn(host.cwd, toWrite[1] ?? '', toWrite[2] ?? ''));
      continue;
    }
    const toLink = /^link:([^=]+)=(.+)$/.exec(word);
    if (toLink !== null) {
      found.push(await linkIn(host.cwd, toLink[1] ?? '', toLink[2] ?? ''));
      continue;
    }
    const url = /^http:(\S+)$/.exec(word)?.[1];
    if (url !== undefined) found.push(await getHttp((tool, args) => host.call(tool, args), url));
  }
  const seen = found.length === 0 ? '' : ` [${found.join('; ')}]`;
  return `consulted on "${question}"${seen}`;
}
