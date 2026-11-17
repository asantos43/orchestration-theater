// SPDX-License-Identifier: MPL-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FRAMEWORK_MCP_NAME, type McpGrant, type McpGrantInput } from './access.js';

/** How many calls of one `submit*` tool a grant has made, valid and invalid. */
export interface SubmitCounter {
  /** Every call, valid or not. */
  calls: number;
  /** Invalid calls since the last valid one. */
  invalid: number;
  /** The N+1-th invalid call happened: the tool is closed for this grant. */
  failed: boolean;
}

/** The server's side of a {@link McpGrant}: what the token stands for. */
export interface GrantRecord {
  readonly id: string;
  readonly input: McpGrantInput;
  readonly submits: Map<string, SubmitCounter>;
  sessionId: string | undefined;
  revoked: boolean;
}

/** Digest of a token: the book holds this, never the token. */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The tokens of the framework server (architecture 5.3). One token per session of one attempt,
 * bound to the role of the attempt: the server lists and runs the tools of that role only.
 *
 * [proposta] The token is minted before `session/new` (it has to be in the `mcpServers` list the
 * session is opened with), so the session id is not known yet: the grant is bound to the attempt
 * and the role, and `bind(sessionId)` records the session once the client has opened it. A token is
 * 32 random bytes (`base64url`); the book keeps the SHA-256 of it, looked up by exact digest, so a
 * guess gains nothing from timing.
 */
export class GrantBook {
  readonly #byDigest = new Map<string, GrantRecord>();
  readonly #url: () => string;

  constructor(url: () => string) {
    this.#url = url;
  }

  get size(): number {
    return this.#byDigest.size;
  }

  grant(input: McpGrantInput): McpGrant {
    const token = randomBytes(32).toString('base64url');
    const key = digest(token);
    const record: GrantRecord = {
      id: randomUUID(),
      input,
      submits: new Map(),
      sessionId: undefined,
      revoked: false,
    };
    this.#byDigest.set(key, record);
    const url = this.#url();
    return {
      role: input.role,
      attemptId: input.attemptId,
      server: {
        name: FRAMEWORK_MCP_NAME,
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
      bind: (sessionId) => {
        record.sessionId = sessionId;
      },
      get sessionId() {
        return record.sessionId;
      },
      revoke: () => {
        record.revoked = true;
        this.#byDigest.delete(key);
      },
    };
  }

  /** The grant a token stands for; `undefined` for an unknown, revoked or malformed token. */
  resolve(token: string): GrantRecord | undefined {
    const record = this.#byDigest.get(digest(token));
    return record === undefined || record.revoked ? undefined : record;
  }

  /** Ends every token (the server is stopping). */
  revokeAll(): void {
    for (const record of this.#byDigest.values()) record.revoked = true;
    this.#byDigest.clear();
  }
}

/** The token of an `Authorization: Bearer <token>` header; `undefined` when it is not one. */
export function bearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]+)[ \t]*$/i.exec(header);
  return match?.[1];
}
