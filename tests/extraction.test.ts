import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProducts } from '../src/core/extraction.js';

test('extraction: complete rows pass', () => {
  const rows = [{ name: 'a', brand: 'b', price: 1, url: 'u' }];
  assert.deepEqual(assertProducts(rows), rows);
});

test('extraction: a missing url fails instead of printing blank', () => {
  const rows = [
    { name: 'a', brand: 'b', price: 1, url: 'u' },
    { name: 'c', brand: 'd', price: 2, url: '' },
  ];
  assert.throws(() => assertProducts(rows), /row 2: url is empty/);
});

test('extraction: a missing price fails too', () => {
  assert.throws(() => assertProducts([{ name: 'a', brand: 'b', url: 'u' }]), /row 1: price is empty/);
});
