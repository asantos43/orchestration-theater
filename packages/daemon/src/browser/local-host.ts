// SPDX-License-Identifier: MPL-2.0
import { isIPv4, isIPv6 } from 'node:net';

/** Lower case, no brackets of an IPv6 literal, no trailing dot of an absolute name. */
export function normalizeHostname(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  return out.endsWith('.') ? out.slice(0, -1) : out;
}

function ipv4Local(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  return (
    a === 0 || // 0.0.0.0/8: "this host"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the metadata address of the clouds
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded), or `undefined` when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  if (!isIPv6(address)) return undefined;
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.split('.').map(Number);
    text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : 8 - first.length - last.length;
  const groups = [...first, ...Array<string>(Math.max(0, fill)).fill('0'), ...last].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 && groups.every((group) => Number.isInteger(group))
    ? groups
    : undefined;
}

function ipv6Local(address: string): boolean {
  const groups = ipv6Groups(address);
  if (groups === undefined) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // `::` and `::1`, and an IPv4 address in an IPv6 shell (`::ffff:a.b.c.d`, `::a.b.c.d`).
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    if (g5 === 0xffff || g5 === 0)
      return ipv4Local(
        `${String(g6 >> 8)}.${String(g6 & 255)}.${String(g7 >> 8)}.${String(g7 & 255)}`,
      );
  }
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80; // unique local, link-local
}

/**
 * True when `hostname` is this machine or its own network: what `browser.local_urls: deny` refuses.
 * [proposta] Wider than the three names the architecture lists (`localhost`, `127.0.0.1`, `[::1]`
 * and `*.localhost`): a rule that only stopped those would leave `127.0.0.2`, `0.0.0.0`, the
 * private ranges and the `169.254.169.254` metadata address one keystroke away. The URL parser has
 * already turned `2130706433` and `0x7f.1` into dotted form when this runs. A NAME that resolves to a
 * private address (a DNS rebinding) cannot be seen here [N].
 */
export function isLocalHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.localdomain') || host.endsWith('.internal')) {
    return true;
  }
  if (isIPv4(host)) return ipv4Local(host);
  return ipv6Local(host);
}
