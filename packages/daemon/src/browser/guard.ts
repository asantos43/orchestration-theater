// SPDX-License-Identifier: MPL-2.0
import type { BrowserGuard, BrowserRequest, BrowserVerdict } from '@otheater/core';
import type { BrowserConfig } from '../config.js';
import { hostAllowed } from '../tools/http-get.js';
import type { FileOrigin } from './file-origin.js';
import { isLocalHost } from './local-host.js';

/** What the rules of a scenario need to judge one request of its page. */
export interface GuardRules {
  readonly scenarioId: string;
  readonly config: Pick<BrowserConfig, 'domains' | 'blocked_domains' | 'local_urls' | 'file_urls'>;
  /** `network.allow` of the role that is acting: the hosts a page may be opened on in `allowlist`. */
  readonly networkAllow: readonly string[];
  readonly files: FileOrigin;
}

/** A request the guard refused, for `browser.refused` (kind `request`). */
export interface GuardRefusal {
  readonly url: string;
  readonly navigation: boolean;
  readonly code: string;
  readonly reason: string;
}

export type GuardVerdict = BrowserVerdict & { readonly code?: string };

/**
 * The rule of a scenario for what its page may load (architecture 5.19), in the order the cases
 * are told apart:
 *
 * 1. Not `http` or `https` (the adapter never loads `file:` itself): refused.
 * 2. The daemon's own file origin. The scenario's token is the only way in, and `file_urls`
 *    decides the file when the request arrives (see `FileOrigin.check`). `browser.domains` and
 *    `browser.local_urls` speak of the network, not of files, so they do not apply to it; with
 *    `file_urls: deny` nothing is let through.
 * 3. `blocked_domains` (any request, any `domains` mode).
 * 4. `local_urls: deny` (any request): this machine and its network, see `isLocalHost`.
 * 5. `domains: allowlist`: a NAVIGATION must go to a host of the role's `network.allow` (localhost
 *    included: a local server needs an entry, like any other host). [proposta] Images, scripts and
 *    the like are not held to the list, or a page could not load its own CDN, while the agent
 *    cannot be sent to a site outside the list by a link, a redirect or a popup.
 *
 * The guard never throws and is cheap: the adapter asks it for every request.
 */
export function makeGuard(
  rules: GuardRules,
  onRefused?: (refusal: GuardRefusal) => void,
): BrowserGuard {
  const refuse = (request: BrowserRequest, code: string, reason: string): GuardVerdict => {
    try {
      onRefused?.({ url: request.url, navigation: request.navigation, code, reason });
    } catch {
      // A broken observer does not let a request through.
    }
    return { allow: false, reason, code };
  };

  return (request): GuardVerdict => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return refuse(request, 'invalid_url', 'The request is not a URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return refuse(
        request,
        'scheme_not_allowed',
        `Only http and https are loaded, not ${url.protocol}`,
      );
    }

    switch (rules.files.judge(rules.scenarioId, url)) {
      case 'allowed':
        return rules.config.file_urls === 'deny'
          ? refuse(request, 'file_urls_denied', 'browser.file_urls is "deny": no file is opened.')
          : { allow: true };
      case 'refused':
        return refuse(
          request,
          'file_origin_refused',
          'The page asked for the daemon file origin with something that is not its own files.',
        );
      case 'foreign':
        break;
    }

    const host = url.hostname;
    if (hostAllowed(host, rules.config.blocked_domains)) {
      return refuse(request, 'domain_blocked', `The host ${host} is in browser.blocked_domains.`);
    }
    if (rules.config.local_urls === 'deny' && isLocalHost(host)) {
      return refuse(
        request,
        'local_url_denied',
        `browser.local_urls is "deny": ${host} is this machine or its network.`,
      );
    }
    if (
      rules.config.domains === 'allowlist' &&
      request.navigation &&
      !hostAllowed(host, rules.networkAllow)
    ) {
      return refuse(
        request,
        'domain_not_allowed',
        `The host ${host} is not in the network.allow of this role (browser.domains is "allowlist").` +
          (rules.networkAllow.length === 0
            ? ' The role may reach no domain.'
            : ` Allowed: ${rules.networkAllow.join(', ')}.`),
      );
    }
    return { allow: true };
  };
}

/** Where a typed URL goes: `file:` becomes the daemon's origin, anything else is as typed. */
export type OpenTarget =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string; readonly suffix: string };

/** Parses what `browser_open` was given: an absolute `http`, `https` or `file` URL. */
export function parseOpenUrl(
  raw: string,
): OpenTarget | { readonly kind: 'invalid'; readonly reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: 'invalid', reason: `"${raw}" is not an absolute URL.` };
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'url', url: url.href };
  if (url.protocol === 'file:') {
    if (url.hostname !== '' && url.hostname !== 'localhost') {
      return { kind: 'invalid', reason: 'A file URL names a path on this machine, not a host.' };
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return { kind: 'invalid', reason: 'The path of the file URL is not valid.' };
    }
    // `file:///C:/x` is `/C:/x` here; the file origin takes the drive letter as the first segment.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return { kind: 'file', path, suffix: `${url.search}${url.hash}` };
  }
  return {
    kind: 'invalid',
    reason: `Only http, https and file URLs are opened, not ${url.protocol}`,
  };
}
