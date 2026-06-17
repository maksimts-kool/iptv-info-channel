import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWithRegen } from '../src/public/admin/regen.js';

// Records the order and arguments of every injected UI side effect.
function makeUi() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    showGenerationPending: rec('pending'),
    clearGenerationPending: rec('clear'),
    toast: rec('toast'),
    load: async () => { calls.push(['load']); },
    refreshGenerationStatus: async () => { calls.push(['refresh']); },
  };
}

test('success path: pending -> action -> toast -> load -> refresh', async () => {
  const ui = makeUi();
  const withRegen = makeWithRegen(ui);
  let actionRan = false;
  await withRegen('Working…', async () => { actionRan = true; }, { success: 'Done' });
  assert.ok(actionRan);
  assert.deepEqual(ui.calls, [
    ['pending', 'Working…'],
    ['toast', 'Done'],
    ['load'],
    ['refresh'],
  ]);
});

test('action runs before any toast/load/refresh', async () => {
  const ui = makeUi();
  const order = [];
  const realToast = ui.toast;
  ui.toast = (m) => { order.push('toast'); realToast(m); };
  const withRegen = makeWithRegen(ui);
  await withRegen('t', async () => { order.push('action'); }, { success: 'ok' });
  assert.deepEqual(order, ['action', 'toast']);
});

test('no success message means no toast on the happy path', async () => {
  const ui = makeUi();
  await makeWithRegen(ui)('t', async () => {});
  assert.deepEqual(ui.calls, [['pending', 't'], ['load'], ['refresh']]);
});

test('reload:false skips the state reload', async () => {
  const ui = makeUi();
  await makeWithRegen(ui)('t', async () => {}, { success: 'ok', reload: false });
  assert.deepEqual(ui.calls, [['pending', 't'], ['toast', 'ok'], ['refresh']]);
});

test('failure path: toast the error and clear the banner, no reload/refresh', async () => {
  const ui = makeUi();
  await makeWithRegen(ui)('t', async () => { throw new Error('boom'); }, { success: 'ok' });
  assert.deepEqual(ui.calls, [
    ['pending', 't'],
    ['toast', 'boom'],
    ['clear'],
  ]);
});
