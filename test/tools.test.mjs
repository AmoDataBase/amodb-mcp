import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TOOL_NAMES, shapeShowtimes, trimResults } from '../dist/tools.js';

// Real API bodies, trimmed (see test/fixtures).
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const ru = fixture('showtimes_ru');
const summary = fixture('showtimes_summary');
const empty = fixture('showtimes_tv_empty');

test('TOOL_NAMES lists get_showtimes and no tool for a path that is not offered', () => {
  assert.ok(TOOL_NAMES.includes('get_showtimes'));
  assert.equal(TOOL_NAMES.length, 9);
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
});

test('trimResults keeps the first items and reports how many it returned', () => {
  const data = { page: 1, results: [{ id: 1 }, { id: 2 }, { id: 3 }], total_results: 3 };
  assert.deepEqual(trimResults(data, 2), { page: 1, results: [{ id: 1 }, { id: 2 }], total_results: 3, returned: 2 });
  assert.deepEqual(trimResults({ movie_results: [] }, 2), { movie_results: [] });
  assert.equal(trimResults(null, 2), null);
});

test('shapeShowtimes limits venues and showtimes per venue and keeps the totals', () => {
  const shaped = shapeShowtimes(ru, 1, 3);
  assert.equal(shaped.country, 'RU');
  assert.equal(shaped.results.length, 1);
  assert.equal(shaped.venues_total, ru.results.length);
  assert.equal(shaped.returned, 1);
  assert.equal(shaped.truncated, true);
  assert.equal(shaped.results[0].showtimes.length, 3);
  assert.equal(shaped.results[0].showtimes_total, ru.results[0].showtimes.length);
  assert.equal(shaped.results[0].name, ru.results[0].name);
  assert.deepEqual(shaped.countries, ru.countries);
  // The input is not changed.
  assert.ok(!('showtimes_total' in ru.results[0]));
  assert.ok(ru.results[0].showtimes.length > 3);
});

test('shapeShowtimes is not truncated when the limits cover everything', () => {
  const shaped = shapeShowtimes(ru, 10, 100);
  assert.equal(shaped.truncated, false);
  assert.equal(shaped.returned, ru.results.length);
  assert.deepEqual(
    shaped.results.map((v) => v.showtimes.length),
    ru.results.map((v) => v.showtimes.length),
  );
});

test('shapeShowtimes marks truncation when only the showtimes are cut', () => {
  const shaped = shapeShowtimes(ru, 10, 1);
  assert.equal(shaped.truncated, true);
  assert.equal(shaped.returned, ru.results.length);
});

test('shapeShowtimes returns the country summary and empty replies unchanged', () => {
  assert.deepEqual(shapeShowtimes(summary, 5, 10), summary);
  assert.deepEqual(shapeShowtimes(empty, 5, 10), empty);
  assert.equal(shapeShowtimes(undefined, 5, 10), undefined);
  assert.deepEqual(shapeShowtimes({ id: 1 }, 5, 10), { id: 1 });
});
