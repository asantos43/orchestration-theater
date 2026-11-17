// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { contract, demand, need, script } from './fixtures.js';
import { ScriptSchema } from './schema.js';
import {
  SCRIPT_ISSUE_CODES,
  normalizeExpectedFile,
  parseScript,
  validateScript,
  type ScriptIssue,
} from './validate.js';

function only(issues: ScriptIssue[]): ScriptIssue {
  expect(issues).toHaveLength(1);
  return need(issues[0]);
}

describe('validateScript: roteiro valido', () => {
  it('aceita um roteiro pronto, com dependencias e contratos', () => {
    const s = script(
      [
        demand('a'),
        demand('b', { dependsOn: ['a'], contract: { inputs: ['c-a'], outputs: ['c-b'] } }),
        demand('c', { dependsOn: ['a'], expectedFiles: ['src/c.ts', 'docs/'] }),
      ],
      [],
    );
    expect(validateScript(s, { demandTimeoutMaxMin: 120 })).toEqual([]);
  });

  it('aceita verifyWaiver no lugar de verify', () => {
    const s = script([demand('a', { verify: [], verifyWaiver: 'Docs only, nothing to run.' })]);
    expect(validateScript(s)).toEqual([]);
  });

  it('aceita unchanged (N84), e so booleano', () => {
    const marked = script([demand('a', { unchanged: true })]);
    expect(validateScript(marked)).toEqual([]);
    expect(ScriptSchema.safeParse(marked).success).toBe(true);
    const wrong = { ...marked, demands: [{ ...need(marked.demands[0]), unchanged: 'yes' }] };
    expect(ScriptSchema.safeParse(wrong).success).toBe(false);
  });

  it('nao limita timeoutMin sem o teto, nem exige timeoutMin', () => {
    const s = script([demand('a', { timeoutMin: 99_999 }), demand('b', { timeoutMin: undefined })]);
    expect(validateScript(s)).toEqual([]);
  });

  it('o schema aceita o roteiro e rejeita campo desconhecido', () => {
    const s = script([demand('a')]);
    expect(ScriptSchema.safeParse(s).success).toBe(true);
    expect(ScriptSchema.safeParse({ ...s, extra: 1 }).success).toBe(false);
  });
});

describe('validateScript: cada regra reprova', () => {
  it('roteiro sem demandas', () => {
    const issue = only(validateScript({ contracts: [], demands: [] }));
    expect(issue.code).toBe(SCRIPT_ISSUE_CODES.EMPTY_SCRIPT);
    expect(issue.demandIds).toEqual([]);
    expect(issue.message).toBe(
      'The script has no demands. Divide the plan into at least one demand.',
    );
  });

  it('id de demanda repetido', () => {
    const s = script([demand('a'), demand('b'), demand('a', { expectedFiles: ['src/other.ts'] })]);
    const issue = only(validateScript(s));
    expect(issue.code).toBe('DUPLICATE_DEMAND_ID');
    expect(issue.demandIds).toEqual(['a']);
    expect(issue.message).toBe(
      'More than one demand has the id "a". Give each demand a unique id.',
    );
  });

  it('id de contrato repetido', () => {
    const s = script([demand('a')]);
    s.contracts.push(contract('c-a'));
    const issue = only(validateScript(s));
    expect(issue.code).toBe('DUPLICATE_CONTRACT_ID');
    expect(issue.contractId).toBe('c-a');
    expect(issue.message).toBe(
      'More than one contract has the id "c-a". Give each contract a unique id.',
    );
  });

  it('dependsOn aponta para demanda que nao existe', () => {
    const s = script([demand('a', { dependsOn: ['zz'] })]);
    const issue = only(validateScript(s));
    expect(issue.code).toBe('UNKNOWN_DEPENDENCY');
    expect(issue.demandIds).toEqual(['a']);
    expect(issue.message).toBe(
      'Demand "a" depends on "zz", but no demand has that id. Add the demand or remove "zz" from dependsOn.',
    );
  });

  it('ciclo: a mensagem mostra o caminho', () => {
    const s = script([
      demand('a', { dependsOn: ['c'] }),
      demand('b', { dependsOn: ['a'] }),
      demand('c', { dependsOn: ['b'] }),
    ]);
    const issue = only(validateScript(s));
    expect(issue.code).toBe('DEPENDENCY_CYCLE');
    expect(issue.demandIds).toEqual(['a', 'c', 'b']);
    expect(issue.message).toBe(
      'Dependency cycle: a -> c -> b -> a ("A -> B" means A depends on B). The demands cannot all wait ' +
        'for each other. Remove a dependsOn entry that no contract or ordering requirement justifies, or merge the demands.',
    );
  });

  it('dependencia da demanda nela mesma e um ciclo', () => {
    const issue = only(validateScript(script([demand('a', { dependsOn: ['a'] })])));
    expect(issue.code).toBe('DEPENDENCY_CYCLE');
    expect(issue.message).toContain('Dependency cycle: a -> a ');
  });

  it('dois ciclos separados geram dois problemas', () => {
    const s = script([
      demand('a', { dependsOn: ['b'] }),
      demand('b', { dependsOn: ['a'] }),
      demand('c', { dependsOn: ['d'] }),
      demand('d', { dependsOn: ['c'] }),
    ]);
    const issues = validateScript(s).filter((i) => i.code === 'DEPENDENCY_CYCLE');
    expect(issues.map((i) => i.demandIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('contrato citado que o roteiro nao declara', () => {
    const s = script([
      demand('a'),
      demand('b', { contract: { inputs: ['nope'], outputs: ['c-b'] } }),
    ]);
    const issue = only(validateScript(s));
    expect(issue.code).toBe('UNKNOWN_CONTRACT');
    expect(issue.demandIds).toEqual(['b']);
    expect(issue.contractId).toBe('nope');
    expect(issue.message).toBe(
      'Demand "b" cites contract "nope" in contract.inputs, but the script declares no contract with that id. Declare the contract in "contracts" or fix the reference.',
    );
  });

  it('contrato de saida desconhecido', () => {
    const s = script([demand('a', { contract: { inputs: [], outputs: ['ghost'] } })]);
    const issue = only(validateScript(s));
    expect(issue.message).toContain('in contract.outputs');
  });

  it('demandas paralelas com o mesmo arquivo', () => {
    const s = script([
      demand('a', { expectedFiles: ['src/shared.ts', 'src/a.ts'] }),
      demand('b', { expectedFiles: ['./src/shared.ts'] }),
    ]);
    const issue = only(validateScript(s));
    expect(issue.code).toBe('PARALLEL_FILE_OVERLAP');
    expect(issue.demandIds).toEqual(['a', 'b']);
    expect(issue.message).toBe(
      'Demands "a" and "b" can run in parallel but both declare "src/shared.ts" in expectedFiles. ' +
        'Make one depend on the other (dependsOn), or move the shared work into its own demand that both depend on.',
    );
  });

  it('dependencia transitiva tira as demandas do paralelismo', () => {
    const s = script([
      demand('a', { expectedFiles: ['src/shared.ts'] }),
      demand('b', { dependsOn: ['a'] }),
      demand('c', { dependsOn: ['b'], expectedFiles: ['src/shared.ts'] }),
    ]);
    expect(validateScript(s)).toEqual([]);
  });

  it('diretorio e arquivo dentro dele se sobrepoem; irmaos de prefixo parecido nao', () => {
    const overlap = script([
      demand('a', { expectedFiles: ['src/core/'] }),
      demand('b', { expectedFiles: ['src/core/x.ts'] }),
    ]);
    const issue = only(validateScript(overlap));
    expect(issue.message).toContain('"src/core/x.ts"');
    const apart = script([
      demand('a', { expectedFiles: ['src/core/'] }),
      demand('b', { expectedFiles: ['src/core-extra/x.ts'] }),
    ]);
    expect(validateScript(apart)).toEqual([]);
  });

  it('caminho que sai do repositorio', () => {
    const s = script([demand('a', { expectedFiles: ['../outside.ts', 'src/a.ts'] })]);
    const issue = only(validateScript(s));
    expect(issue.code).toBe('INVALID_EXPECTED_FILE');
    expect(issue.message).toBe(
      'Demand "a" lists expectedFiles entry "../outside.ts", which is not a path inside the repository. ' +
        'Use a path relative to the repository root, without "..", without a leading "/", and end a directory with "/".',
    );
  });

  it('timeoutMin acima do teto', () => {
    const s = script([demand('a', { timeoutMin: 180 })]);
    const issue = only(validateScript(s, { demandTimeoutMaxMin: 120 }));
    expect(issue.code).toBe('TIMEOUT_ABOVE_MAX');
    expect(issue.message).toBe(
      'Demand "a" asks for timeoutMin 180, above the maximum of 120 minutes. Lower timeoutMin, or split the demand into smaller ones.',
    );
    expect(
      validateScript(script([demand('a', { timeoutMin: 120 })]), { demandTimeoutMaxMin: 120 }),
    ).toEqual([]);
  });

  it('sem criterios de aceite', () => {
    const issue = only(validateScript(script([demand('a', { acceptanceCriteria: [] })])));
    expect(issue.code).toBe('MISSING_ACCEPTANCE_CRITERIA');
    expect(issue.message).toBe(
      'Demand "a" has no acceptanceCriteria. List at least one observable criterion that tells the Actor when the demand is done.',
    );
  });

  it('sem contrato de saida', () => {
    const issue = only(
      validateScript(script([demand('a', { contract: { inputs: [], outputs: [] } })])),
    );
    expect(issue.code).toBe('MISSING_OUTPUT_CONTRACT');
    expect(issue.message).toBe(
      'Demand "a" has no output contract. Declare in contract.outputs what it delivers (files, API, types, schema).',
    );
  });

  it('sem expectedFiles', () => {
    const issue = only(validateScript(script([demand('a', { expectedFiles: [] })])));
    expect(issue.code).toBe('MISSING_EXPECTED_FILES');
    expect(issue.message).toBe(
      'Demand "a" has no expectedFiles. List the files or directories it will touch; they are used to detect conflicts between parallel demands.',
    );
  });

  it('sem verify e sem verifyWaiver', () => {
    const issue = only(validateScript(script([demand('a', { verify: [] })])));
    expect(issue.code).toBe('MISSING_VERIFICATION');
    expect(issue.message).toBe(
      'Demand "a" has no verify step and no verifyWaiver. Add at least one verify step (a test or lint command), or explain in verifyWaiver why none applies.',
    );
  });

  it('verify e verifyWaiver juntos', () => {
    const issue = only(validateScript(script([demand('a', { verifyWaiver: 'not needed' })])));
    expect(issue.code).toBe('VERIFY_AND_WAIVER');
    expect(issue.message).toBe(
      'Demand "a" has both verify steps and a verifyWaiver. Keep the verify steps and drop the waiver, or drop the steps and keep the waiver.',
    );
  });

  it('lista todos os problemas de uma vez, na ordem das regras', () => {
    const s = script([demand('a', { dependsOn: ['zz'], acceptanceCriteria: [], timeoutMin: 500 })]);
    expect(validateScript(s, { demandTimeoutMaxMin: 120 }).map((i) => i.code)).toEqual([
      'UNKNOWN_DEPENDENCY',
      'TIMEOUT_ABOVE_MAX',
      'MISSING_ACCEPTANCE_CRITERIA',
    ]);
  });

  it('nao lanca com demandas de id repetido e dependencias quebradas', () => {
    const s = script([
      demand('a', { dependsOn: ['b', 'zz'] }),
      demand('a', { dependsOn: ['a'] }),
      demand('b', { dependsOn: ['a'] }),
    ]);
    expect(() => validateScript(s)).not.toThrow();
  });
});

describe('parseScript', () => {
  it('devolve o roteiro quando a forma esta certa', () => {
    const s = script([demand('a')]);
    const result = parseScript(JSON.parse(JSON.stringify(s)));
    expect(result.success).toBe(true);
    if (result.success) expect(result.script).toEqual(s);
  });

  it('transforma erro de forma em problemas, com o id da demanda', () => {
    const s = script([demand('a')]);
    const bad = JSON.parse(JSON.stringify(s)) as { demands: Record<string, unknown>[] };
    const first = need(bad.demands[0]);
    first.complexity = 'huge';
    first.surprise = true;
    const result = parseScript(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.every((i) => i.code === 'SCHEMA_INVALID')).toBe(true);
      expect(result.issues.every((i) => i.demandIds[0] === 'a')).toBe(true);
      const messages = result.issues.map((i) => i.message);
      expect(messages.some((m) => m.startsWith('Invalid field demands[0].complexity: '))).toBe(
        true,
      );
      expect(messages).toContain(
        'Invalid field demands[0]: unknown field(s) "surprise". Fix it and submit the script again.',
      );
    }
  });

  it('entrada que nem e objeto', () => {
    const result = parseScript(null);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(need(result.issues[0]).message).toMatch(/^Invalid field \(script\): /);
  });

  it('o id precisa servir de nome de ref do git', () => {
    const s = script([demand('a/b')]);
    expect(parseScript(s).success).toBe(false);
  });
});

describe('normalizeExpectedFile', () => {
  it.each([
    ['src/a.ts', { path: 'src/a.ts', directory: false }],
    ['./src//a.ts', { path: 'src/a.ts', directory: false }],
    ['src/x/../a.ts', { path: 'src/a.ts', directory: false }],
    ['src\\a.ts', { path: 'src/a.ts', directory: false }],
    ['src/', { path: 'src', directory: true }],
  ])('normaliza %s', (raw, expected) => {
    expect(normalizeExpectedFile(raw)).toEqual(expected);
  });

  it.each(['/etc/passwd', 'C:/x', '..', '../a', 'a/../..', '.', './', '  '])('recusa %s', (raw) => {
    expect(normalizeExpectedFile(raw)).toBeUndefined();
  });
});
