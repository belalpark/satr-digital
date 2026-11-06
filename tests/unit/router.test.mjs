import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash, teamNameFromSearch } from '../../assets/js/router.js';

test('empty hash is the welcome view', () => {
  assert.deepEqual(parseHash(''), { view: 'welcome' });
  assert.deepEqual(parseHash('#/'), { view: 'welcome' });
  assert.deepEqual(parseHash('#'), { view: 'welcome' });
});

test('plan with scene query', () => {
  assert.deepEqual(parseHash('#/plan?scene=visitor-path'), { view: 'plan', scene: 'visitor-path' });
  assert.deepEqual(parseHash('#/plan'), { view: 'plan' });
});

test('room and details routes', () => {
  assert.deepEqual(parseHash('#/room/meeting-large'), { view: 'room', roomId: 'meeting-large' });
  assert.deepEqual(parseHash('#/room/meeting-large/details'), { view: 'details', roomId: 'meeting-large' });
});

test('unknown routes fall back to plan', () => {
  assert.deepEqual(parseHash('#/whatever/x'), { view: 'plan' });
});

test('buildHash round-trips', () => {
  assert.equal(buildHash({ view: 'welcome' }), '#/');
  assert.equal(buildHash({ view: 'plan', scene: 'team-layout' }), '#/plan?scene=team-layout');
  assert.equal(buildHash({ view: 'plan', scene: 'current' }), '#/plan');
  assert.equal(buildHash({ view: 'room', roomId: 'ceo' }), '#/room/ceo');
  assert.equal(buildHash({ view: 'details', roomId: 'ceo' }), '#/room/ceo/details');
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
