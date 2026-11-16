// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import {
  fail,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
  requireStringArray,
  UsageError,
  type JsonRecord,
} from './common.js';

/** Who decided, when, why and where it is recorded. Every decision in the policy carries these. */
export interface Decision {
  decidedBy: string;
  date: string;
  reason: string;
  source: string;
}

export interface LicenseDecision extends Decision {
  license: string;
}

export type ExceptionScope = 'production' | 'development' | 'any';

export interface PackageException extends Decision {
  package: string;
  /** semver range; absent means every version. */
  versions: string | undefined;
  /** Exact license text the tool reads; if the package changes it, the exception stops applying. */
  license: string | undefined;
  scope: ExceptionScope;
  /** Only an explicit owner decision may open an exception for a forbidden license. */
  allowForbidden: boolean;
}

export interface ExternalTool extends Decision {
  package: string;
}

export interface CredentialAllowlistEntry extends Decision {
  /** Repository-relative path; a trailing "/" means every file below that directory. */
  path: string;
}

export interface HeadersPolicy {
  ownLicense: string;
  headerLines: number;
  extensions: string[];
  excludedPrefixes: string[];
  excludedDirectories: string[];
}

export interface CredentialsPolicy {
  excludedPrefixes: string[];
}

export interface CatalogsPolicy {
  directory: string;
  requiredLanguages: string[];
  referenceLanguage: string;
}

export interface Policy {
  allowed: string[];
  forbidden: string[];
  acceptedInDependencies: LicenseDecision[];
  packageExceptions: PackageException[];
  externalTools: ExternalTool[];
  credentialAllowlist: CredentialAllowlistEntry[];
  headers: HeadersPolicy;
  credentials: CredentialsPolicy;
  catalogs: CatalogsPolicy;
}

function parseDecision(rec: JsonRecord, where: string): Decision {
  return {
    decidedBy: requireString(rec, 'decidedBy', where),
    date: requireString(rec, 'date', where),
    reason: requireString(rec, 'reason', where),
    source: requireString(rec, 'source', where),
  };
}

function parseEntries<T>(
  value: unknown,
  where: string,
  parse: (rec: JsonRecord, at: string) => T,
): T[] {
  if (value === undefined) return [];
  return requireArray(value, where).map((item, i) => {
    const at = `${where}[${String(i)}]`;
    return parse(requireRecord(item, at), at);
  });
}

function parseScope(rec: JsonRecord, where: string): ExceptionScope {
  const scope = rec.scope ?? 'any';
  if (scope !== 'production' && scope !== 'development' && scope !== 'any') {
    fail(where, '"scope" must be "production", "development" or "any"');
  }
  return scope;
}

function stringArrayOr(rec: JsonRecord, key: string, fallback: string[], where: string): string[] {
  const value = rec[key];
  return value === undefined ? fallback : requireStringArray(value, `${where}.${key}`);
}

function sectionOr(rec: JsonRecord, key: string): JsonRecord {
  const value = rec[key];
  return value === undefined ? {} : requireRecord(value, `policy.${key}`);
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

export function parsePolicy(raw: unknown, where = 'policy'): Policy {
  const root = requireRecord(raw, where);
  const headers = sectionOr(root, 'headers');
  const credentials = sectionOr(root, 'credentials');
  const catalogs = sectionOr(root, 'catalogs');
  const headerLines = headers.headerLines ?? 5;
  if (typeof headerLines !== 'number' || !Number.isInteger(headerLines) || headerLines < 1) {
    fail(`${where}.headers`, '"headerLines" must be a positive integer');
  }
  return {
    allowed: requireStringArray(root.allowed, `${where}.allowed`),
    forbidden: requireStringArray(root.forbidden, `${where}.forbidden`),
    acceptedInDependencies: parseEntries(
      root.acceptedInDependencies,
      `${where}.acceptedInDependencies`,
      (rec, at) => ({ license: requireString(rec, 'license', at), ...parseDecision(rec, at) }),
    ),
    packageExceptions: parseEntries(
      root.packageExceptions,
      `${where}.packageExceptions`,
      (rec, at) => {
        const allowForbidden = rec.allowForbidden ?? false;
        if (typeof allowForbidden !== 'boolean') fail(at, '"allowForbidden" must be a boolean');
        return {
          package: requireString(rec, 'package', at),
          versions: optionalString(rec, 'versions', at),
          license: optionalString(rec, 'license', at),
          scope: parseScope(rec, at),
          allowForbidden,
          ...parseDecision(rec, at),
        };
      },
    ),
    externalTools: parseEntries(root.externalTools, `${where}.externalTools`, (rec, at) => ({
      package: requireString(rec, 'package', at),
      ...parseDecision(rec, at),
    })),
    credentialAllowlist: parseEntries(
      root.credentialAllowlist,
      `${where}.credentialAllowlist`,
      (rec, at) => ({ path: requireString(rec, 'path', at), ...parseDecision(rec, at) }),
    ),
    headers: {
      ownLicense: optionalString(headers, 'ownLicense', `${where}.headers`) ?? 'MPL-2.0',
      headerLines,
      extensions: stringArrayOr(headers, 'extensions', DEFAULT_EXTENSIONS, `${where}.headers`),
      excludedPrefixes: stringArrayOr(
        headers,
        'excludedPrefixes',
        ['spikes/', 'docs/'],
        `${where}.headers`,
      ),
      excludedDirectories: stringArrayOr(
        headers,
        'excludedDirectories',
        ['node_modules', 'dist', 'dist-test'],
        `${where}.headers`,
      ),
    },
    credentials: {
      excludedPrefixes: stringArrayOr(
        credentials,
        'excludedPrefixes',
        ['spikes/', 'docs/'],
        `${where}.credentials`,
      ),
    },
    catalogs: {
      directory: optionalString(catalogs, 'directory', `${where}.catalogs`) ?? 'locales',
      requiredLanguages: stringArrayOr(
        catalogs,
        'requiredLanguages',
        ['en', 'pt-BR'],
        `${where}.catalogs`,
      ),
      referenceLanguage: optionalString(catalogs, 'referenceLanguage', `${where}.catalogs`) ?? 'en',
    },
  };
}

export function loadPolicy(file: string): Policy {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new UsageError(
      `cannot read policy file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `policy file ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsePolicy(json, 'policy.json');
}
