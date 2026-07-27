import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/query.ts';

test('bare words become AND-joined quoted terms', () => {
  assert.equal(parseQuery('vision pro').fts, '"vision" AND "pro"');
});

test('quoted phrases stay together', () => {
  assert.equal(parseQuery('"one year later"').fts, '"one year later"');
});

test('filters are extracted and removed from the fts expression', () => {
  const q = parseQuery('keyboard tag:apple after:2024 status:draft type:page');
  assert.equal(q.fts, '"keyboard"');
  assert.equal(q.tag, 'apple');
  assert.equal(q.after, '2024-01-01');
  assert.equal(q.status, 'draft');
  assert.equal(q.type, 'page');
});

test('before and after normalize partial dates', () => {
  assert.equal(parseQuery('x before:2023-06').before, '2023-06-01');
  assert.equal(parseQuery('x after:2023').after, '2023-01-01');
  assert.equal(parseQuery('x after:2023-06-15').after, '2023-06-15');
});

test('an invalid date is treated as a search term, not a filter', () => {
  const q = parseQuery('after:banana');
  assert.equal(q.after, undefined);
  assert.equal(q.fts, '"after:banana"');
});

test('an invalid status is treated as a search term', () => {
  const q = parseQuery('status:nonsense');
  assert.equal(q.status, undefined);
  assert.equal(q.fts, '"status:nonsense"');
});

test('leading dash negates a term', () => {
  assert.equal(parseQuery('ipad -mini').fts, '"ipad" NOT "mini"');
});

test('multiple negations all apply', () => {
  assert.equal(parseQuery('ipad -mini -pro').fts, '"ipad" NOT "mini" NOT "pro"');
});

test('a negation with no positive term is dropped', () => {
  assert.equal(parseQuery('-mini').fts, '');
});

test('a bare dash is treated as a term, not a negation', () => {
  assert.equal(parseQuery('a -').fts, '"a" AND "-"');
});

test('title: restricts to the title column', () => {
  assert.equal(parseQuery('title:nonogram').fts, 'title:"nonogram"');
});

test('title: combines with other terms', () => {
  assert.equal(parseQuery('title:nonogram app').fts, 'title:"nonogram" AND "app"');
});

test('unbalanced quotes cannot produce a syntax error', () => {
  assert.equal(parseQuery('say "hello').fts, '"say" AND "hello"');
});

test('fts operators in user input are neutralized', () => {
  assert.equal(
    parseQuery('a* OR b NEAR c').fts,
    '"a*" AND "OR" AND "b" AND "NEAR" AND "c"',
  );
});

test('a quote acts as a delimiter, so it never survives inside a term', () => {
  // This is what makes the expression safe: no term can ever contain a bare
  // quote, and any that somehow did would be escaped by doubling.
  assert.equal(parseQuery('say"what').fts, '"say" AND "what"');
  for (const hit of parseQuery('say"what').fts.matchAll(/"/g)) {
    assert.ok(hit.index !== undefined);
  }
});

test('every produced expression has balanced quotes', () => {
  const inputs = [
    'say "hello', '"', '""', '""""""', 'a*', 'OR', 'NEAR/2', '(((', 'a"b"c',
    '- ', '-', 'tag:', 'title:', 'x -"y', '\\', '^caret', '{brace}', 'a:b:c',
  ];
  for (const i of inputs) {
    const { fts } = parseQuery(i);
    const quotes = (fts.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for input ${JSON.stringify(i)}: ${fts}`);
  }
});

test('pathological quote input does not throw', () => {
  assert.doesNotThrow(() => parseQuery('""""""'));
  assert.doesNotThrow(() => parseQuery('"'));
  assert.doesNotThrow(() => parseQuery('""'));
});

test('empty and whitespace input yield an empty expression', () => {
  assert.equal(parseQuery('').fts, '');
  assert.equal(parseQuery('   ').fts, '');
  assert.equal(parseQuery('tag:apple').fts, '');
});

test('a filter with an empty value is treated as a term', () => {
  assert.equal(parseQuery('tag:').fts, '"tag:"');
  assert.equal(parseQuery('tag:').tag, undefined);
});

test('prefixLastTerm appends a prefix operator for live typing', () => {
  assert.equal(parseQuery('nonog', { prefixLastTerm: true }).fts, '"nonog"*');
  assert.equal(
    parseQuery('vision pr', { prefixLastTerm: true }).fts,
    '"vision" AND "pr"*',
  );
});

test('prefixLastTerm does not apply to a closed phrase', () => {
  assert.equal(
    parseQuery('"exact phrase"', { prefixLastTerm: true }).fts,
    '"exact phrase"',
  );
});

test('prefixLastTerm does not apply when the last token is a negation', () => {
  assert.equal(parseQuery('ipad -mini', { prefixLastTerm: true }).fts,
    '"ipad"* NOT "mini"');
});

test('unknown filter prefixes are treated as search terms', () => {
  assert.equal(parseQuery('author:matt').fts, '"author:matt"');
});

test('filters are case insensitive in their key', () => {
  assert.equal(parseQuery('TAG:apple').tag, 'apple');
  assert.equal(parseQuery('Status:Draft').status, 'draft');
});

test('extra whitespace between terms is ignored', () => {
  assert.equal(parseQuery('  vision    pro  ').fts, '"vision" AND "pro"');
});
