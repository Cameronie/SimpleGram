// Browser tests for the Filter status diagnostics (counts and timings only).
//
// Run: NODE_PATH=/opt/node-tools/node_modules node --test tests/*.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowser, open, BLANK } = require('./helpers.cjs');

useBrowser();

test('diagnostics: opening Stories records how long the first Story took to play', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  await page.evaluate(() => {
    history.pushState(null, '', '/stories/friend/3700000000000000001/');
    const v = document.createElement('video');
    document.querySelector('main').appendChild(v);
    setTimeout(() => v.dispatchEvent(new Event('playing')), 120);
  });
  await page.waitForFunction(() => window.__sg.stats.diag.storyMs.length === 1);
  const d = await page.evaluate(() => window.__sg.stats.diag);
  assert.ok(d.storyMs[0] >= 100 && d.storyMs[0] < 5000, String(d.storyMs[0]));
  // Moving to the next Story is not a new opening.
  await page.evaluate(() => {
    history.pushState(null, '', '/stories/friend/3700000000000000002/');
    document.querySelector('video').dispatchEvent(new Event('playing'));
  });
  assert.equal((await page.evaluate(() => window.__sg.stats.diag.storyMs)).length, 1);
});

test('diagnostics: the status report carries counts only', async () => {
  const page = await open('https://www.instagram.com/', BLANK);
  const stats = await page.evaluate(() => window.__sg.stats);
  for (const key of ['storyMs', 's429', 's5xx', 'longTasks', 'longestTask']) assert.ok(key in stats.diag, key);
  assert.doesNotMatch(JSON.stringify(stats.diag), /instagram\.com|friend/);
});

test('diagnostics: Instagram\'s "please wait" answers are counted, whichever way they are read', async () => {
  const body = { message: 'Please wait a few minutes before you try again.', status: 'fail' };
  const page = await open('https://www.instagram.com/', BLANK, { api: { '/api/v1/feed/x/': () => ({ status: 400, body }) } });
  await page.evaluate(b => JSON.parse(JSON.stringify(b)), body);
  await page.evaluate(() => fetch('/api/v1/feed/x/').then(r => r.json()));
  // Ordinary answers and GraphQL errors that aren't throttling are not counted.
  await page.evaluate(() => JSON.parse('{"status":"ok","items":[]}'));
  await page.evaluate(() => JSON.parse('{"errors":[{"message":"execution error","code":1675004}],"data":null}'));
  assert.equal(await page.evaluate(() => window.__sg.stats.diag.pleaseWait), 2);
});
