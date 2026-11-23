// SPDX-License-Identifier: MPL-2.0
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Which addresses `http_get` will not reach with `shell.http_get.block_private: on` (P8 of Phase 11).
 * An allowlisted NAME can resolve to the machine itself or to the network behind it (a public name
 * with a private record, `localhost`, the cloud metadata address 169.254.169.254), and a literal IP in
 * a URL or in a redirect is the same thing without the name. The check is on the address, after the
 * name is resolved, and on the literal when there is one.
 *
 * Refused: this host (0.0.0.0/8, 127/8, ::, ::1), private (10/8, 172.16/12, 192.168/16, fc00::/7),
 * shared address space (100.64/10), link-local (169.254/16, fe80::/10, site-local fec0::/10), the
 * special blocks of IANA (192.0.0/24, 198.18/15), multicast and reserved (224/4, 240/4, ff00::/8) and
 * every IPv6 form that carries an IPv4 address (mapped `::ffff:a.b.c.d`, compatible `::a.b.c.d`,
 * NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), judged by the IPv4 inside it.
 */

/** Four octets of a dotted IPv4, or `undefined` when the text is not one. */
function parseIPv4(text: string): [number, number, number, number] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

function isPrivateIPv4([a, b, c]: readonly [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 text (with `::` and a dotted tail), or `undefined`. */
function parseIPv6(text: string): number[] | undefined {
  let rest = text;
  const zone = rest.indexOf('%');
  if (zone >= 0) rest = rest.slice(0, zone);
  const tail = rest.lastIndexOf(':');
  const dotted = rest.slice(tail + 1);
  if (dotted.includes('.')) {
    const v4 = parseIPv4(dotted);
    if (v4 === undefined) return undefined;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    rest = `${rest.slice(0, tail + 1)}${hi}:${lo}`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups = part.split(':').map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : Number.NaN));
    return groups.some((group) => Number.isNaN(group)) ? undefined : groups;
  };
  const head = groupsOf(halves[0] ?? '');
  if (head === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const back = groupsOf(halves[1] ?? '');
  if (back === undefined || head.length + back.length > 7) return undefined;
  return [...head, ...Array.from({ length: 8 - head.length - back.length }, () => 0), ...back];
}

function ipv4Of(high: number, low: number): [number, number, number, number] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPrivateIPv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroTo5 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroTo5 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (zeroTo5 && g5 === 0xffff) return isPrivateIPv4(ipv4Of(g6, g7)); // ::ffff:a.b.c.d
  if (zeroTo5 && g5 === 0) return isPrivateIPv4(ipv4Of(g6, g7)); // ::a.b.c.d (deprecated)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(ipv4Of(g6, g7)); // NAT64
  }
  if (g0 === 0x2002) return isPrivateIPv4(ipv4Of(g1, g2)); // 6to4
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only 100::/64
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  return (g0 & 0xff00) === 0xff00; // multicast
}

/**
 * True when the text is an IP address `block_private` refuses. `false` for a name (not an IP at
 * all): the caller resolves it first. An IPv6 literal may come with or without brackets.
 */
export function isPrivateAddress(address: string): boolean {
  const text = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(text);
  if (family === 4) {
    const octets = parseIPv4(text);
    return octets === undefined ? true : isPrivateIPv4(octets);
  }
  if (family === 6) {
    const groups = parseIPv6(text);
    // An address that node accepts and this parser does not is not worth the doubt.
    return groups === undefined ? true : isPrivateIPv6(groups);
  }
  return false;
}

/** The names that are this machine whatever the DNS says (RFC 6761): `localhost` and `*.localhost`. */
export function isLocalName(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost');
}

/** What `http_get` calls to turn a name into its addresses; a test hands in a double. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/** The system resolver: every address of the name (A and AAAA), as `getaddrinfo` gives them. */
export const systemResolver: HostResolver = async (hostname) => {
  const found = await lookup(hostname, { all: true, order: 'verbatim' });
  return found.map((entry) => entry.address);
};
