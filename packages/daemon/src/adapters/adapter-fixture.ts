// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { parseAdapterLock, type AdapterLock } from './lock.js';

/** Test fixture of Phase 10, P13: tarballs made in memory and a registry on the loopback that serves them. */

export interface FixtureFile {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

const BLOCK = 512;

function field(value: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  buffer.write(value, 0, 'utf8');
  return buffer;
}

function header(name: string, size: number, type: string, mode: number, prefix = ''): Buffer {
  const block = Buffer.alloc(BLOCK);
  field(name, 100).copy(block, 0);
  field(mode.toString(8).padStart(7, '0'), 8).copy(block, 100);
  field('0000000', 8).copy(block, 108);
  field('0000000', 8).copy(block, 116);
  field(size.toString(8).padStart(11, '0'), 12).copy(block, 124);
  field('00000000000', 12).copy(block, 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 'ascii');
  block.write('ustar', 257, 'ascii');
  block.write('00', 263, 'ascii');
  field(prefix, 155).copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

function body(content: Buffer): Buffer {
  return Buffer.concat([content, Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK)]);
}

export interface TarOptions {
  /** `pax`: names go in a pax header; `gnu`: in a `L` entry; `prefix`: in the ustar prefix field. Default plain. */
  readonly longNames?: 'pax' | 'gnu' | 'prefix';
  /** Extra raw entries to append (traversal tests). */
  readonly extra?: readonly { name: string; type?: string; content?: string }[];
}

/** A tar of `package/<path>` entries, as `npm pack` makes it. */
export function makeTar(files: readonly FixtureFile[], options: TarOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const add = (name: string, content: Buffer, type: string, mode: number): void => {
    if (options.longNames === 'pax') {
      const record = ` path=${name}\n`;
      let length = record.length + 1;
      while (String(length).length + record.length !== length)
        length = String(length).length + record.length;
      const paxData = Buffer.from(`${String(length)}${record}`);
      parts.push(header('PaxHeader', paxData.length, 'x', 0o644), body(paxData));
      parts.push(header('x', content.length, type, mode), body(content));
    } else if (options.longNames === 'gnu') {
      const long = Buffer.from(`${name}\0`);
      parts.push(header('././@LongLink', long.length, 'L', 0o644), body(long));
      parts.push(header('x', content.length, type, mode), body(content));
    } else if (options.longNames === 'prefix') {
      const slash = name.lastIndexOf('/');
      parts.push(
        header(name.slice(slash + 1), content.length, type, mode, name.slice(0, slash)),
        body(content),
      );
    } else {
      parts.push(header(name, content.length, type, mode), body(content));
    }
  };
  parts.push(header('package/', 0, '5', 0o755));
  for (const file of files)
    add(`package/${file.path}`, Buffer.from(file.content), '0', file.mode ?? 0o644);
  for (const extra of options.extra ?? [])
    add(extra.name, Buffer.from(extra.content ?? ''), extra.type ?? '0', 0o644);
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function makeTarball(files: readonly FixtureFile[], options: TarOptions = {}): Buffer {
  return gzipSync(makeTar(files, options));
}

export function integrityOf(data: Buffer): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

export interface FixturePackage {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly files: readonly FixtureFile[];
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly optional?: true;
}

export interface FixtureAdapter {
  readonly lock: AdapterLock;
  /** The tarball of each `<name>/-/<base>-<version>.tgz` path, as the registry serves it. */
  readonly tarballs: ReadonlyMap<string, Buffer>;
}

export function tarballPath(name: string, version: string): string {
  return `/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
}

/** A small adapter: the package `fake-acp` (entry `dist/index.js`) and whatever else `extra` adds. */
export function fixtureAdapter(extra: readonly FixturePackage[] = []): FixtureAdapter {
  const packages: FixturePackage[] = [
    {
      path: 'node_modules/fake-acp',
      name: 'fake-acp',
      version: '1.2.3',
      files: [
        { path: 'package.json', content: '{"name":"fake-acp","version":"1.2.3","type":"module"}' },
        { path: 'dist/index.js', content: 'console.log("fake-acp");\n', mode: 0o755 },
      ],
    },
    ...extra,
  ];
  const tarballs = new Map<string, Buffer>();
  const entries = packages.map((pkg) => {
    const tarball = makeTarball(pkg.files);
    tarballs.set(tarballPath(pkg.name, pkg.version), tarball);
    return {
      path: pkg.path,
      name: pkg.name,
      version: pkg.version,
      integrity: integrityOf(tarball),
      ...(pkg.os === undefined ? {} : { os: pkg.os }),
      ...(pkg.cpu === undefined ? {} : { cpu: pkg.cpu }),
      ...(pkg.optional === undefined ? {} : { optional: pkg.optional }),
    };
  });
  const lock = {
    ...parseAdapterLock({
      schema: 1,
      id: 'claude-agent-acp',
      package: 'fake-acp',
      version: '1.2.3',
      entry: 'dist/index.js',
      entries,
    }),
  };
  return { lock, tarballs };
}

export interface FakeRegistry {
  readonly url: string;
  /** Every request path, in order. */
  readonly requests: string[];
  /** Answers the next requests with this status (then goes back to serving). */
  failNext(status: number, times?: number): void;
  /** Replaces what a path serves. */
  serve(pathName: string, data: Buffer): void;
  /** Holds every answer until `release()` (concurrency tests). */
  hold(): () => void;
  close(): Promise<void>;
}

export async function startFakeRegistry(adapter: FixtureAdapter): Promise<FakeRegistry> {
  const tarballs = new Map(adapter.tarballs);
  const requests: string[] = [];
  let failures: { status: number; times: number } | undefined;
  let gate: Promise<void> | undefined;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathName = request.url ?? '';
    requests.push(pathName);
    const answer = (): void => {
      if (failures !== undefined && failures.times > 0) {
        failures.times -= 1;
        response.writeHead(failures.status).end();
        return;
      }
      const data = tarballs.get(pathName);
      if (data === undefined) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': data.length,
        })
        .end(data);
    };
    if (gate === undefined) answer();
    else void gate.then(answer);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    failNext: (status, times = 1) => {
      failures = { status, times };
    },
    serve: (pathName, data) => tarballs.set(pathName, data),
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
