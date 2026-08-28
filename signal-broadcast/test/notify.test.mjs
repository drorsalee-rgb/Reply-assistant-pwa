// The allowlist is the only thing standing between this endpoint and an
// arbitrary-send capability, so its edges are worth pinning down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notify = require('../src/notify.js');

test('the same number in different spellings is one number', () => {
  const forms = ['+972547554469', '972547554469', '0547554469',
                 '054-755-4469', '054 755 4469', '00972547554469'];
  for(const form of forms){
    assert.equal(notify.normalisePhone(form), '+972547554469', form);
  }
});

test('an allowlisted number passes however it is written', () => {
  for(const form of ['0547554469', '054-755-4469', '+972 54 755 4469']){
    const result = notify.validate({ phones: [form], message: 'hello' });
    assert.equal(result.ok, true, form);
    assert.deepEqual(result.phones, ['+972547554469']);
  }
});

test('a number that is not on the list is refused with 403', () => {
  const result = notify.validate({ phones: ['+972500000000'], message: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('one bad number refuses the whole call, not just that recipient', () => {
  const result = notify.validate({
    phones: ['+972547554469', '+972500000000'],
    message: 'hello'
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('the refusal names only the last four digits', () => {
  const result = notify.validate({ phones: ['+972500000123'], message: 'hi' });
  assert.match(result.error, /…0123/);
  assert.doesNotMatch(result.error, /972500000123/);
});

test('NOTIFY_ALLOWLIST replaces the built-in list rather than adding to it', () => {
  const previous = process.env.NOTIFY_ALLOWLIST;
  process.env.NOTIFY_ALLOWLIST = '+972500000000';
  try{
    assert.equal(notify.validate({ phones: ['+972500000000'], message: 'hi' }).ok, true);
    // Dror's number is in DEFAULT_ALLOWLIST and must not survive the override.
    assert.equal(notify.validate({ phones: ['+972547554469'], message: 'hi' }).ok, false);
  }finally{
    if(previous === undefined) delete process.env.NOTIFY_ALLOWLIST;
    else process.env.NOTIFY_ALLOWLIST = previous;
  }
});

test('a recipient list long enough to be a broadcast is refused', () => {
  const result = notify.validate({
    phones: new Array(notify.MAX_RECIPIENTS + 1).fill('+972547554469'),
    message: 'hello'
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('an empty or missing message is refused', () => {
  for(const message of [undefined, '', '   ', 42]){
    const result = notify.validate({ phones: ['+972547554469'], message });
    assert.equal(result.ok, false, String(message));
    assert.equal(result.status, 400);
  }
});

test('a message past Beacon\'s cap is refused rather than silently truncated', () => {
  const result = notify.validate({
    phones: ['+972547554469'],
    message: 'x'.repeat(notify.MAX_MESSAGE_CHARS + 1)
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('a phone with no digits is rejected before the allowlist is consulted', () => {
  const result = notify.validate({ phones: ['not a phone'], message: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});
