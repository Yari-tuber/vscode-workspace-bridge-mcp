'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissionLease, CAPABILITIES } = require('../src/permission-lease');

test('privileges expire on access even when the event loop delays the timer', () => {
  const access = { read: true }; let clock = 1000, revoked = 0;
  const lease = createPermissionLease(access, { now: () => clock, schedule: () => 1, unschedule() {}, onExpire: () => revoked++ });
  lease.grant(['edit', 'refactor', 'tasks'], 500);
  assert.equal(lease.get().refactor, true);
  clock = 1500;
  assert.equal(lease.get().refactor, false);
  assert.equal(lease.get().tasks, false);
  assert.equal(lease.get().read, true);
  assert.equal(revoked, 1);
  assert.equal(lease.expiresAt, 0);
});

test('changing a local grant removes old capabilities and clears the prior timer', () => {
  const access = { read: true }; const cleared = [];
  const lease = createPermissionLease(access, { schedule: () => 8, unschedule: id => cleared.push(id) });
  lease.grant(['terminal', 'git'], 1000);
  lease.grant(['edit'], 0);
  assert.equal(lease.get().terminal, false);
  assert.equal(lease.get().git, false);
  assert.equal(lease.get().edit, true);
  assert.deepEqual(cleared, [8]);
  assert.equal(lease.expiresAt, 0);
  assert.deepEqual(Object.keys(lease.get()), CAPABILITIES);
  assert.throws(() => lease.grant(['administrator'], 500));
  assert.throws(() => lease.grant(['tasks'], -1));
});
