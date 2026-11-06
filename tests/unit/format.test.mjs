import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatsLabel } from '../../assets/js/format.js';

test('Arabic seat labels agree with the number', () => {
  assert.equal(seatsLabel(1), 'مقعد واحد');
  assert.equal(seatsLabel(2), 'مقعدان');
  assert.equal(seatsLabel(3), '3 مقاعد');
  assert.equal(seatsLabel(10), '10 مقاعد');
  assert.equal(seatsLabel(11), '11 مقعدًا');
  assert.equal(seatsLabel(16), '16 مقعدًا');
});
