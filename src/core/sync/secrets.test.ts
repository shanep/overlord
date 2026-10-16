import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createMemorySecretStore,
  findPlaceholders,
  isSecretName,
  looksLikeSecret,
  placeholderFor,
  placeholdersInText,
  redact,
  resolveSecrets,
  resolveSecretsInText,
  scanForSecrets,
  type SecretRule,
} from './secrets.js';

describe('memory secret store', () => {
  it('gets, sets and deletes', async () => {
    const store = createMemorySecretStore({ A: '1' });
    expect(await store.get('A')).toBe('1');
    await store.set('B', '2');
    expect(await store.get('B')).toBe('2');
    await store.delete('A');
    expect(await store.get('A')).toBeUndefined();
    expect(await createMemorySecretStore().get('A')).toBeUndefined();
  });
});

describe('placeholders', () => {
  it('builds and finds placeholders', () => {
    expect(placeholderFor('GITHUB_TOKEN')).toBe('${secret:GITHUB_TOKEN}');
    expect(() => placeholderFor('bad name')).toThrow('Invalid secret name: bad name');
    expect(isSecretName('a.b-c_1')).toBe(true);
    expect(isSecretName('')).toBe(false);
    expect(placeholdersInText('x ${secret:A} ${secret:b.c} ${secret:} ${A}')).toStrictEqual([
      'A',
      'b.c',
    ]);
    expect(
      findPlaceholders({ a: ['${secret:Z}', { b: 'Bearer ${secret:A}' }], c: 1, d: '${secret:Z}' }),
    ).toStrictEqual(['A', 'Z']);
  });

  it('resolves placeholders in nested values and reports missing ones', async () => {
    const store = createMemorySecretStore({ TOKEN: 't0k', KEY: 'k' });
    const value = {
      env: { GITHUB_TOKEN: '${secret:TOKEN}', OTHER: 'plain' },
      args: ['--key=${secret:KEY}', '${secret:GONE}', 3],
      flag: true,
    };
    expect(await resolveSecrets(value, store)).toStrictEqual({
      value: {
        env: { GITHUB_TOKEN: 't0k', OTHER: 'plain' },
        args: ['--key=k', '${secret:GONE}', 3],
        flag: true,
      },
      missing: ['GONE'],
    });
  });

  it('resolves one string', async () => {
    const store = createMemorySecretStore({ A: 'x' });
    expect(await resolveSecretsInText('a=${secret:A} b=${secret:B}', store)).toStrictEqual({
      text: 'a=x b=${secret:B}',
      missing: ['B'],
    });
  });
});

const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const upperDigits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function charsFrom(alphabet: string, min: number, max: number): fc.Arbitrary<string> {
  return fc
    .array(
      fc.nat({ max: alphabet.length - 1 }).map((index) => alphabet.charAt(index)),
      { minLength: min, maxLength: max },
    )
    .map((chars) => chars.join(''));
}

const tokens: readonly (readonly [SecretRule, fc.Arbitrary<string>])[] = [
  ['anthropic-key', charsFrom(`${alnum}_-`, 20, 100).map((body) => `sk-ant-api03-${body}`)],
  [
    'github-token',
    fc
      .tuple(fc.constantFrom('ghp', 'gho', 'ghu', 'ghs', 'ghr'), charsFrom(alnum, 36, 60))
      .map(([prefix, body]) => `${prefix}_${body}`),
  ],
  ['github-pat', charsFrom(`${alnum}_`, 22, 90).map((body) => `github_pat_${body}`)],
  [
    'aws-access-key',
    fc
      .tuple(fc.constantFrom('AKIA', 'ASIA'), charsFrom(upperDigits, 16, 16))
      .map(([prefix, body]) => `${prefix}${body}`),
  ],
  [
    'slack-token',
    fc
      .tuple(fc.constantFrom('xoxb', 'xoxp', 'xoxa', 'xoxe'), charsFrom(`${alnum}-`, 10, 60))
      .map(([prefix, body]) => `${prefix}-${body}`),
  ],
  [
    'slack-webhook',
    charsFrom(`${alnum}/`, 20, 60).map((body) => `https://hooks.slack.com/services/${body}`),
  ],
  [
    'private-key',
    fc
      .constantFrom('', 'RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ')
      .map((kind) => `-----BEGIN ${kind}PRIVATE KEY-----`),
  ],
  [
    'bearer-token',
    fc
      .tuple(fc.constantFrom('Bearer', 'bearer', 'BEARER'), charsFrom(`${alnum}._~+/-`, 20, 80))
      .map(([word, body]) => `Authorization: ${word} ${body}`),
  ],
];

const filler = fc.string({ maxLength: 40 }).map((text) => text.replaceAll(/[\w-]/gu, ' '));

describe('scanForSecrets', () => {
  it('finds every generated token shape wherever it sits', () => {
    for (const [rule, token] of tokens) {
      fc.assert(
        fc.property(filler, token, filler, (before, secret, after) => {
          const text = `${before}\n${secret}\n${after}`;
          const found = scanForSecrets(text);
          const match = found.find((finding) => finding.rule === rule);
          expect(match).toBeDefined();
          const start = before.length + 1;
          expect(match?.index).toBeGreaterThanOrEqual(start);
          expect(match?.index).toBeLessThan(start + secret.length);
          expect(match?.line).toBe(before.split('\n').length + 1);
        }),
      );
    }
  });

  it('reports position, line and a short preview, in order', () => {
    const text = 'a\nb ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nAKIAABCDEFGHIJKLMNOP';
    expect(scanForSecrets(text)).toStrictEqual([
      { rule: 'github-token', index: 4, line: 2, preview: 'ghp_aa...' },
      { rule: 'aws-access-key', index: 45, line: 3, preview: 'AKIAAB...' },
    ]);
    expect(redact('abcdefgh')).toBe('abcdef...');
  });

  it('does not flag ordinary text or placeholders', () => {
    const clean = [
      'Use the GitHub API with a token from the keychain.',
      'Authorization: Bearer ${secret:GITHUB}',
      'ghp_short',
      'sk-ant-short',
      'AKIA1234',
      '-----BEGIN PUBLIC KEY-----',
    ];
    for (const text of clean) {
      expect(scanForSecrets(text)).toStrictEqual([]);
    }
  });
});

describe('looksLikeSecret', () => {
  it('flags token shapes and literals under sensitive names', () => {
    expect(looksLikeSecret('X', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(looksLikeSecret('API_KEY', 'abcdefgh')).toBe(true);
    expect(looksLikeSecret('Authorization', 'Basic abcdefgh')).toBe(true);
    expect(looksLikeSecret('DB_PASSWORD', 'hunter22')).toBe(true);
    expect(looksLikeSecret('client_secret', 'abcdefgh')).toBe(true);
  });

  it('leaves short values, references and plain settings alone', () => {
    expect(looksLikeSecret('API_KEY', 'abcdefg')).toBe(false);
    expect(looksLikeSecret('API_KEY', '${secret:API_KEY}')).toBe(false);
    expect(looksLikeSecret('API_KEY', '${API_KEY}')).toBe(false);
    expect(looksLikeSecret('LOG_LEVEL', 'debug-verbose')).toBe(false);
  });
});
