import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/utils.mjs';

test('slugify: lowercases and joins words with a hyphen', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify: collapses runs of non-alphanumeric chars and trims hyphens', () => {
  assert.equal(slugify('  Foo--Bar !!  '), 'foo-bar');
});

test('slugify: returns empty string when input has no ASCII alphanumeric chars', () => {
  assert.equal(slugify('Привет'), '');
});

test('slugify: replaces dots, plus signs, and hyphens with a single hyphen', () => {
  assert.equal(slugify('v4.7-beta+build'), 'v4-7-beta-build');
});
