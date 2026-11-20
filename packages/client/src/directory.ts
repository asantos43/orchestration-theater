// SPDX-License-Identifier: MPL-2.0
import { DaemonIdSchema, type ApiStatus, type DaemonId } from '@otheater/protocol';
import { z } from 'zod';
import { ApiClient, type CallControl, type FetchLike } from './client.js';
import { DaemonDirectoryError } from './errors.js';

/**
 * The list of daemons the client talks to (decisions N134 and N168; plan docs/17 P9). A client may
 * hold several connections at once: the local daemon, found alone by discovery, and any number of
 * saved ones (a daemon on another machine, reached over the user's VPN in Phase 12). Each is a name,
 * a URL, the `daemonId` the connection must answer with and a token. This module has no file and no
 * Node API: the list is kept by a {@link DaemonListStore} (the file one is in `./node`) and the
 * local daemon is found by a {@link LocalDaemonSource}.
 */

/** The name of the daemon found by discovery. Saved entries cannot use it. */
export const LOCAL_DAEMON_NAME = 'local';

/** Version of the list file written by this code. */
export const DAEMON_LIST_VERSION = 1;

/** One connection of the list. Holds a secret (the token): keep the file at mode 0600. */
export const DaemonConnectionSchema = z.strictObject({
  /** What the person calls it; unique in the list. */
  name: z.string().trim().min(1).max(64),
  /** Base URL of the API, `http` or `https`. */
  url: z.url({ protocol: /^https?$/ }),
  /** The id this address must answer with; checked on every connect. */
  daemonId: DaemonIdSchema,
  /** [proposta] Printable ASCII with no space, so it can go in a header as is. */
  token: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[\x21-\x7e]+$/),
  /** Reserved for Phase 12: the pinned fingerprint of a TLS certificate. Nothing reads it yet. */
  fingerprint: z.string().min(1).max(256).optional(),
});
export type DaemonConnection = z.infer<typeof DaemonConnectionSchema>;

/** What the list file holds. */
export const DaemonListFileSchema = z.strictObject({
  version: z.literal(DAEMON_LIST_VERSION),
  daemons: z.array(DaemonConnectionSchema),
});
export type DaemonListFile = z.infer<typeof DaemonListFileSchema>;

/** A connection of the list and where it came from. */
export type DaemonEntry = DaemonConnection & {
  /** `local`: found by discovery, never saved. `saved`: in the list. */
  readonly source: 'local' | 'saved';
};

/** Where the saved connections live. */
export interface DaemonListStore {
  /** The saved connections; an absent list is empty. Throws `DaemonDirectoryError` when the list is unreadable. */
  load(): Promise<readonly DaemonConnection[]>;
  /** Replaces the whole list. */
  save(list: readonly DaemonConnection[]): Promise<void>;
}

/** A list in memory, for tests and for runtimes with no file (a browser keeps it elsewhere). */
export class MemoryDaemonListStore implements DaemonListStore {
  #list: readonly DaemonConnection[];

  constructor(initial: readonly DaemonConnection[] = []) {
    this.#list = initial;
  }

  load(): Promise<readonly DaemonConnection[]> {
    return Promise.resolve(this.#list);
  }

  save(list: readonly DaemonConnection[]): Promise<void> {
    this.#list = [...list];
    return Promise.resolve();
  }
}

/** What discovery finds about the daemon of this machine. */
export interface LocalDaemon {
  readonly url: string;
  readonly daemonId: DaemonId;
  readonly token: string;
}

/** Finds the local daemon; `undefined` when none is running. Never throws for "not found". */
export interface LocalDaemonSource {
  discover(): Promise<LocalDaemon | undefined>;
}

export interface DaemonDirectoryOptions {
  readonly store: DaemonListStore;
  readonly local?: LocalDaemonSource | undefined;
  /** Passed to every client the directory makes. */
  readonly fetch?: FetchLike | undefined;
  readonly timeoutMs?: number | undefined;
}

/** What to add to the list. */
export interface NewDaemonConnection {
  readonly name: string;
  readonly url: string;
  readonly token: string;
  readonly daemonId: DaemonId;
  readonly fingerprint?: string | undefined;
}

/** A daemon the client reached and checked. */
export interface ConnectedDaemon {
  readonly entry: DaemonEntry;
  readonly client: ApiClient;
  readonly status: ApiStatus;
}

/** The result of one entry in {@link DaemonDirectory.connectAll}: a failure of one does not hide the others. */
export type DaemonConnectOutcome =
  | { readonly entry: DaemonEntry; readonly ok: true; readonly connected: ConnectedDaemon }
  | { readonly entry: DaemonEntry; readonly ok: false; readonly error: unknown };

/** The base URL as the list keeps it: no trailing slash, no query, no fragment, no credentials. */
function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new DaemonDirectoryError('invalid_entry', `"${url}" is not a URL`, { cause });
  }
  if (
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new DaemonDirectoryError(
      'invalid_entry',
      'The URL of a daemon has no query, fragment or credentials',
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Validates one connection and normalizes its URL. */
export function parseDaemonConnection(input: unknown): DaemonConnection {
  const parsed = DaemonConnectionSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new DaemonDirectoryError(
      'invalid_entry',
      `Invalid daemon entry: ${first?.path.join('.') ?? ''}: ${first?.message ?? 'unknown'}`,
      { cause: parsed.error },
    );
  }
  return { ...parsed.data, url: normalizeUrl(parsed.data.url) };
}

export class DaemonDirectory {
  readonly #store: DaemonListStore;
  readonly #local: LocalDaemonSource | undefined;
  readonly #fetch: FetchLike | undefined;
  readonly #timeoutMs: number | undefined;
  /** Writes run one after another, so two `add` at once keep both. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: DaemonDirectoryOptions) {
    this.#store = options.store;
    this.#local = options.local;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  /**
   * The local daemon (when one runs) and the saved ones, in that order. [proposta] When a saved
   * entry has the `daemonId` of the local one, the local one wins and the saved one is left out of
   * the list (it stays in the file), so a scenario never shows twice.
   */
  async list(): Promise<DaemonEntry[]> {
    const [saved, local] = await Promise.all([this.#store.load(), this.#local?.discover()]);
    const entries: DaemonEntry[] = [];
    if (local !== undefined) {
      entries.push({
        name: LOCAL_DAEMON_NAME,
        url: normalizeUrl(local.url),
        daemonId: local.daemonId,
        token: local.token,
        source: 'local',
      });
    }
    for (const connection of saved) {
      if (local?.daemonId === connection.daemonId) continue;
      entries.push({ ...connection, source: 'saved' });
    }
    return entries;
  }

  async get(name: string): Promise<DaemonEntry | undefined> {
    return (await this.list()).find((entry) => entry.name === name);
  }

  async getByDaemonId(daemonId: DaemonId): Promise<DaemonEntry | undefined> {
    return (await this.list()).find((entry) => entry.daemonId === daemonId);
  }

  /**
   * Saves a connection. It does not touch the network: the `daemonId` comes from the caller (use
   * {@link enroll} to learn it from the daemon). The name and the id must be new.
   */
  async add(input: NewDaemonConnection): Promise<DaemonEntry> {
    const connection = parseDaemonConnection(input);
    if (connection.name === LOCAL_DAEMON_NAME) {
      throw new DaemonDirectoryError('reserved_name', `"${LOCAL_DAEMON_NAME}" is the local daemon`);
    }
    return this.#write((list) => {
      if (list.some((other) => other.name === connection.name)) {
        throw new DaemonDirectoryError(
          'duplicate_name',
          `There is already a daemon "${connection.name}"`,
        );
      }
      const same = list.find((other) => other.daemonId === connection.daemonId);
      if (same !== undefined) {
        throw new DaemonDirectoryError(
          'duplicate_daemon',
          `The daemon ${connection.daemonId} is already in the list as "${same.name}"`,
        );
      }
      return { list: [...list, connection], result: { ...connection, source: 'saved' } };
    });
  }

  /**
   * Saves a connection whose `daemonId` is not known yet: asks `GET /v1/status` and keeps the id
   * that answers. [proposta] It trusts the first answer (the id is learned, not checked); from
   * then on every connect checks it, and the fingerprint of Phase 12 will pin the certificate.
   */
  async enroll(
    input: Omit<NewDaemonConnection, 'daemonId'>,
    options: CallControl = {},
  ): Promise<DaemonEntry> {
    const probe = parseDaemonConnection({ ...input, daemonId: NIL_DAEMON_ID });
    const status = await new ApiClient({
      url: probe.url,
      token: probe.token,
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
    }).connect(options);
    return this.add({ ...input, daemonId: status.daemonId });
  }

  /** Changes the URL, token or fingerprint of a saved entry (a rotated token, a new port). */
  async update(
    name: string,
    patch: { url?: string; token?: string; fingerprint?: string },
  ): Promise<DaemonEntry> {
    if (name === LOCAL_DAEMON_NAME) throw readOnly();
    return this.#write((list) => {
      const current = list.find((entry) => entry.name === name);
      if (current === undefined) throw notFound(name);
      const next = parseDaemonConnection({ ...current, ...patch });
      return {
        list: list.map((entry) => (entry === current ? next : entry)),
        result: { ...next, source: 'saved' },
      };
    });
  }

  /** Removes a saved entry. The local daemon cannot be removed: discovery finds it again. */
  async remove(name: string): Promise<void> {
    if (name === LOCAL_DAEMON_NAME) throw readOnly();
    await this.#write((list) => {
      if (!list.some((entry) => entry.name === name)) throw notFound(name);
      return { list: list.filter((entry) => entry.name !== name), result: undefined };
    });
  }

  /** A client for an entry, with no call made. Its `daemonId` is the entry's. */
  clientFor(entry: DaemonConnection): ApiClient {
    return new ApiClient({
      url: entry.url,
      token: entry.token,
      daemonId: entry.daemonId,
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
    });
  }

  /**
   * Connects to an entry by name: asks `GET /v1/status` and checks the `daemonId` and the API
   * version. Rejects with the typed errors of the client (`DaemonIdMismatchError`, `ApiVersionError`,
   * `ApiNetworkError`...), or `DaemonDirectoryError` `not_found` for an unknown name.
   */
  async connect(name: string, options: CallControl = {}): Promise<ConnectedDaemon> {
    const entry = await this.get(name);
    if (entry === undefined) throw notFound(name);
    return this.connectEntry(entry, options);
  }

  async connectEntry(entry: DaemonEntry, options: CallControl = {}): Promise<ConnectedDaemon> {
    const client = this.clientFor(entry);
    const status = await client.connect(options);
    return { entry, client, status };
  }

  /** Connects to every entry at once; a daemon that is down or wrong is an outcome, not a throw. */
  async connectAll(options: CallControl = {}): Promise<DaemonConnectOutcome[]> {
    const entries = await this.list();
    return Promise.all(
      entries.map(async (entry): Promise<DaemonConnectOutcome> => {
        try {
          return { entry, ok: true, connected: await this.connectEntry(entry, options) };
        } catch (error) {
          return { entry, ok: false, error };
        }
      }),
    );
  }

  /** Read-modify-write of the saved list, one at a time. */
  #write<T>(
    change: (list: readonly DaemonConnection[]) => { list: readonly DaemonConnection[]; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const { list, result } = change(await this.#store.load());
      await this.#store.save(list);
      return result;
    };
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

/** A well-formed id only for the probe of {@link DaemonDirectory.enroll}: it is never sent nor kept. */
const NIL_DAEMON_ID = '00000000-0000-4000-8000-000000000000';

function notFound(name: string): DaemonDirectoryError {
  return new DaemonDirectoryError('not_found', `There is no daemon "${name}" in the list`);
}

function readOnly(): DaemonDirectoryError {
  return new DaemonDirectoryError(
    'read_only',
    `"${LOCAL_DAEMON_NAME}" is found by discovery: it is not in the list`,
  );
}
