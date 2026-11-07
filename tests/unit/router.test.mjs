import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash, teamNameFromSearch } from '../../assets/js/router.js';

test('empty hash is the welcome view', () => {
  assert.deepEqual(parseHash(''), { view: 'welcome' });
  assert.deepEqual(parseHash('#/'), { view: 'welcome' });
  assert.deepEqual(parseHash('#'), { view: 'welcome' });
});

test('plan with scene query', () => {
  assert.deepEqual(parseHash('#/plan?scene=paths'), { view: 'plan', scene: 'paths' });
  assert.deepEqual(parseHash('#/plan'), { view: 'plan' });
});

test('room focus, photos and details routes', () => {
  assert.deepEqual(parseHash('#/room/meeting-large'), { view: 'room', roomId: 'meeting-large' });
  assert.deepEqual(parseHash('#/room/meeting-large/photos'), { view: 'photos', roomId: 'meeting-large' });
  assert.deepEqual(parseHash('#/room/meeting-large/details'), { view: 'details', roomId: 'meeting-large' });
  assert.deepEqual(parseHash('#/room/meeting-large/nope'), { view: 'plan' });
  // an explicit view in a photos / details link is kept (it overrides the visitor's saved view)
  assert.deepEqual(parseHash('#/room/cfo/details?view=2d'), { view: 'details', roomId: 'cfo', mode: '2d' });
  assert.deepEqual(parseHash('#/room/cfo/photos?view=3d'), { view: 'photos', roomId: 'cfo', mode: '3d' });
  assert.deepEqual(parseHash('#/room/cfo/details?view=nope'), { view: 'details', roomId: 'cfo' });
});

test('unknown routes fall back to plan', () => {
  assert.deepEqual(parseHash('#/whatever/x'), { view: 'plan' });
});

test('buildHash round-trips', () => {
  assert.equal(buildHash({ view: 'welcome' }), '#/');
  assert.equal(buildHash({ view: 'plan', scene: 'paths' }), '#/plan?scene=paths');
  assert.equal(buildHash({ view: 'plan', scene: 'current' }), '#/plan');
  assert.equal(buildHash({ view: 'room', roomId: 'ceo' }), '#/room/ceo');
  assert.equal(buildHash({ view: 'photos', roomId: 'ceo' }), '#/room/ceo/photos');
  assert.equal(buildHash({ view: 'details', roomId: 'ceo' }), '#/room/ceo/details');
  assert.equal(buildHash({ view: 'details', roomId: 'ceo', mode: '2d' }), '#/room/ceo/details?view=2d');
  assert.equal(buildHash({ view: 'photos', roomId: 'ceo', mode: '3d' }), '#/room/ceo/photos?view=3d');
  for (const h of ['#/room/ceo/details?view=2d', '#/room/ceo/photos?view=3d', '#/room/ceo?view=3d', '#/plan?scene=paths&view=2d']) assert.equal(buildHash(parseHash(h)), h);
});

test('team name is decoded, trimmed, limited and defaulted', () => {
  assert.equal(teamNameFromSearch('?team=%D8%B4%D8%B1%D9%83%D8%A9%20%D9%86%D9%88%D8%B1', 'فريقكم'), 'شركة نور');
  assert.equal(teamNameFromSearch('?team=', 'فريقكم'), 'فريقكم');
  assert.equal(teamNameFromSearch('', 'فريقكم'), 'فريقكم');
  assert.equal(teamNameFromSearch('?team=+++', 'فريقكم'), 'فريقكم');
  assert.equal(teamNameFromSearch('?team=' + 'ن'.repeat(100), 'فريقكم').length, 60);
  // markup is kept as plain text; rendering uses textContent, never innerHTML
  assert.equal(teamNameFromSearch('?team=%3Cb%3Ex%3C%2Fb%3E', 'فريقكم'), '<b>x</b>');
});
