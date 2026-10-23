'use strict';

const CAPABILITIES = Object.freeze(['read', 'edit', 'refactor', 'tasks', 'git', 'terminal']);
const PRIVILEGED = CAPABILITIES.filter(value => value !== 'read');

/** Local, window-scoped grants. A deadline is checked on every access, not only by a timer. */
function createPermissionLease(access, { onExpire = () => {}, now = Date.now, schedule = setTimeout, unschedule = clearTimeout } = {}) {
  let deadline = 0;
  let timer;
  function clear() { if (timer !== undefined) unschedule(timer); timer = undefined; deadline = 0; }
  function expire() {
    if (!deadline || now() < deadline) return;
    clear();
    for (const key of PRIVILEGED) access[key] = false;
    onExpire();
  }
  function grant(keys, durationMs) {
    if (!Array.isArray(keys) || keys.some(key => !PRIVILEGED.includes(key)) ||
        !Number.isInteger(durationMs) || durationMs < 0 || durationMs > 7_200_000) throw new TypeError('Invalid local permission lease.');
    clear();
    for (const key of PRIVILEGED) access[key] = keys.includes(key);
    if (keys.length && durationMs) { deadline = now() + durationMs; timer = schedule(expire, durationMs); timer?.unref?.(); }
  }
  function get() { expire(); return Object.fromEntries(CAPABILITIES.map(key => [key, access[key] === true])); }
  return { grant, clear, get, get expiresAt() { expire(); return deadline; } };
}

module.exports = { CAPABILITIES, createPermissionLease };
