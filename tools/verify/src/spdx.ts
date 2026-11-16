// SPDX-License-Identifier: MPL-2.0
import parseSpdx from 'spdx-expression-parse';
import type { Policy } from './policy.js';

/** Ordered from best to worst: "OR" takes the lower rank, "AND" the higher. */
export type Verdict = 'allowed' | 'accepted' | 'undecided' | 'forbidden';

const RANK: Record<Verdict, number> = { allowed: 0, accepted: 1, undecided: 2, forbidden: 3 };

export interface Classification {
  verdict: Verdict;
  /** License ids found in the expression, in reading order. */
  ids: string[];
  reason: string | undefined;
}

export interface LicenseRules {
  allowed: ReadonlySet<string>;
  accepted: ReadonlyMap<string, string>;
  forbidden: readonly RegExp[];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function buildRules(policy: Policy): LicenseRules {
  return {
    allowed: new Set(policy.allowed.map((id) => id.toLowerCase())),
    accepted: new Map(
      policy.acceptedInDependencies.map((d) => [
        d.license.toLowerCase(),
        `${d.license}: accepted in dependencies (${d.date})`,
      ]),
    ),
    forbidden: policy.forbidden.map(globToRegExp),
  };
}

function classifyId(id: string, rules: LicenseRules): Classification {
  const lower = id.toLowerCase();
  // Forbidden is checked first: an accepted-license decision never opens a forbidden license.
  if (rules.forbidden.some((re) => re.test(id))) {
    return { verdict: 'forbidden', ids: [id], reason: `${id} is on the forbidden list` };
  }
  if (rules.allowed.has(lower)) return { verdict: 'allowed', ids: [id], reason: undefined };
  const accepted = rules.accepted.get(lower);
  if (accepted !== undefined) return { verdict: 'accepted', ids: [id], reason: accepted };
  return { verdict: 'undecided', ids: [id], reason: `${id} is not on any list: no decision` };
}

interface SpdxLeaf {
  license: string;
  plus?: true | undefined;
  exception?: string | undefined;
}
interface SpdxNode {
  conjunction: 'and' | 'or';
  left: SpdxLeaf | SpdxNode;
  right: SpdxLeaf | SpdxNode;
}

function classifyNode(node: SpdxLeaf | SpdxNode, rules: LicenseRules): Classification {
  if ('license' in node) {
    // "WITH <exception>": the base license decides. "GPL-2.0+" is matched by its base id.
    return classifyId(node.license, rules);
  }
  const left = classifyNode(node.left, rules);
  const right = classifyNode(node.right, rules);
  const ids = [...left.ids, ...right.ids];
  const pick =
    node.conjunction === 'or'
      ? RANK[left.verdict] <= RANK[right.verdict]
        ? left
        : right
      : RANK[left.verdict] >= RANK[right.verdict]
        ? left
        : right;
  return { ...pick, ids };
}

const NOT_A_LICENSE = /^(unknown|unlicensed|none|custom\b.*|see license.*)$/i;

/** Classifies the license text a package declares. Anything that is not a valid SPDX expression is "undecided". */
export function classifyLicense(text: string | undefined, rules: LicenseRules): Classification {
  const value = (text ?? '').trim();
  if (value === '' || NOT_A_LICENSE.test(value)) {
    return {
      verdict: 'undecided',
      ids: [value === '' ? 'UNKNOWN' : value],
      reason: `license "${value === '' ? 'missing' : value}" is not identified`,
    };
  }
  try {
    return classifyNode(parseSpdx(value), rules);
  } catch {
    return {
      verdict: 'undecided',
      ids: [value],
      reason: `"${value}" is not a valid SPDX expression`,
    };
  }
}

export function worse(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

export function verdictRank(verdict: Verdict): number {
  return RANK[verdict];
}
