// SPDX-License-Identifier: MPL-2.0
import { createHmac } from 'node:crypto';
import { InvalidInput, isSecretPath, type SandboxRequest } from '@otheater/core';

/** The four lists of the `filesystem` block of `sandbox-runtime`. */
export interface FilesystemRules {
  readonly denyRead: readonly string[];
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly denyWrite: readonly string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/**
 * What `sandbox-runtime` is told to deny on READ for a list of secret paths. An entry with a `/`
 * goes as it is (it is already absolute; `*` and `?` are the glob of the library). A bare name
 * (`.env`, `.env.*`) matches in any folder, but the library needs a literal folder to start from
 * (a pattern that starts with a wildcard is skipped, and a skipped deny hides nothing), so the name
 * is anchored under each of `roots` (`<root>/**\/.env`). [proposta] A `.env` outside the roots
 * stays readable: the worktree and the extra write folders are where a command works.
 */
export function readDenies(
  secretPaths: readonly string[],
  roots: readonly string[],
): readonly string[] {
  const denies: string[] = [];
  for (const entry of secretPaths) {
    if (entry.includes('/')) {
      denies.push(trimSlashes(entry));
      continue;
    }
    for (const root of roots) denies.push(`${trimSlashes(root)}/**/${entry}`);
  }
  return unique(denies);
}

/**
 * The filesystem rules of one request (architecture 5.8, layer 3): write only in the worktree,
 * the profile folders of the client, `extraWritePaths` and the temporary folder of the adapter;
 * read everything except the secret paths. A worktree or profile folder that lies INSIDE a secret
 * path (the data directory of the daemon holds both) is read again by `allowRead`, which beats
 * `denyRead` for the same path in the library. So is a `readPaths` folder (the managed ACP
 * adapters, P13), which is read but never written.
 */
export function filesystemRules(request: SandboxRequest, tempDir: string): FilesystemRules {
  const writable = unique([
    request.worktree,
    ...request.profileDirs,
    ...request.extraWritePaths,
    tempDir,
  ]);
  const reopened = [request.worktree, ...request.profileDirs, ...(request.readPaths ?? [])].filter(
    (path) => isSecretPath(path, request.secretPaths),
  );
  return {
    denyRead: readDenies(request.secretPaths, [request.worktree, ...request.extraWritePaths]),
    allowRead: unique(reopened),
    allowWrite: writable,
    denyWrite: [],
  };
}

/** Domains the command may reach: the ones of the role policy, the ones the daemon added and the bridged ports. */
export function allowedDomains(request: SandboxRequest): readonly string[] {
  return unique([
    ...request.policy.network.allow,
    ...request.domains,
    ...(request.loopbackPorts ?? []).map((port) => `localhost:${String(port)}`),
  ]);
}

/**
 * The ports the library already listens on inside the sandbox (its HTTP and SOCKS relays): a
 * listener of the bridge on one of them would collide with the relay.
 */
const RELAY_PORTS: readonly number[] = [3128, 1080];
/** [proposta] Longest wait, in 50 ms steps, for a listener of the bridge to be up before the command starts. */
const BRIDGE_READY_STEPS = 40;

/** The ports of `loopbackPorts`, validated, without repeats. Throws `InvalidInput`. */
export function bridgePorts(request: SandboxRequest): readonly number[] {
  const ports = [...new Set(request.loopbackPorts ?? [])];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new InvalidInput(`loopbackPorts: "${String(port)}" is not a TCP port`);
    }
    if (RELAY_PORTS.includes(port)) {
      throw new InvalidInput(
        `loopbackPorts: port ${String(port)} is taken by a relay of the sandbox library inside the sandbox`,
      );
    }
  }
  return ports;
}

/**
 * The script that runs INSIDE the sandbox, after the seccomp filter, when the request has
 * `loopbackPorts` (N115). For each port it starts a `socat` that listens on `127.0.0.1:<port>` of
 * the network the sandbox has to itself (`--unshare-net`) and forwards each connection, with an HTTP
 * CONNECT to `localhost:<port>`, to the proxy of the library on `localhost:3128`, which is the end of
 * its own Unix-socket bridge to the host and applies the network list of the command (so only the
 * bridged ports of the host are reached). Everything here is TCP: the seccomp filter of the library
 * blocks `socket(AF_UNIX)` for the command, and a bridge of its own over a Unix socket would need
 * that filter off for the whole client (measured, N115). The proxy credentials are the ones the
 * library puts in the environment (`CLOUDSDK_PROXY_*`). The listener runs before the command and the
 * command replaces the shell (`exec`), so its exit status and signals are the command's. Pure.
 */
export function bridgeScript(
  ports: readonly number[],
  cmd: string,
  args: readonly string[],
): string {
  const lines = [
    '_ot_listen() {',
    `  _ot_to="PROXY:localhost:localhost:$1,proxyport=3128,proxyauth=$CLOUDSDK_PROXY_USERNAME:$CLOUDSDK_PROXY_PASSWORD"`,
    // Both families, like the library does for its own relays: a client that resolves `localhost`
    // to ::1 gets an answer too; IPv4 alone where the kernel has no IPv6.
    '  { socat "TCP6-LISTEN:$1,ipv6only=0,fork,reuseaddr,backlog=256" "$_ot_to" ||',
    '    exec socat "TCP4-LISTEN:$1,fork,reuseaddr,backlog=256" "$_ot_to"; } >/dev/null 2>&1 &',
    '}',
    '_ot_ready() {',
    '  _ot_n=0',
    `  while [ "$_ot_n" -lt ${String(BRIDGE_READY_STEPS)} ]; do`,
    '    for _ot_f in /proc/net/tcp /proc/net/tcp6; do',
    '      [ -r "$_ot_f" ] || continue',
    '      while read -r _ot_i _ot_l _ot_r _ot_s _ot_rest; do',
    '        [ "${_ot_l##*:}" = "$1" ] && [ "$_ot_s" = 0A ] && return 0',
    '      done < "$_ot_f"',
    '    done',
    '    _ot_n=$((_ot_n + 1))',
    '    sleep 0.05',
    '  done',
    '  return 1',
    '}',
  ];
  for (const port of ports) {
    const hex = port.toString(16).toUpperCase().padStart(4, '0');
    lines.push(
      `_ot_listen ${String(port)}`,
      `_ot_ready ${hex} || echo "otheater: the bridge to the daemon on port ${String(port)} did not come up" >&2`,
    );
  }
  lines.push(
    'unset _ot_to _ot_n _ot_f _ot_i _ot_l _ot_r _ot_s _ot_rest',
    `exec ${shellLine(cmd, args)}`,
  );
  return lines.join('\n');
}

/** One argument quoted for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `cmd args...` as one line for a POSIX shell, each word quoted. */
export function shellLine(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].map(shellQuote).join(' ');
}

/**
 * The id under which the network list of a request is registered in the library (it travels in
 * the proxy user name). It must be unguessable (at least 128 bits), but the SAME request must give
 * the SAME id, so the wrapped command, and the key of a shared process, stay stable for a
 * worktree. An HMAC with a secret that lives as long as the adapter does both. [proposta]
 */
export function commandIdFor(secret: Buffer, request: SandboxRequest, tempDir: string): string {
  const material = JSON.stringify([
    request.worktree,
    [...request.profileDirs].sort(),
    [...(request.readPaths ?? [])].sort(),
    [...request.extraWritePaths].sort(),
    [...request.secretPaths].sort(),
    [...allowedDomains(request)].sort(),
    request.policy.writeScope,
    bridgePorts(request),
    tempDir,
  ]);
  return createHmac('sha256', secret).update(material).digest('base64url');
}
