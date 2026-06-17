// Most admin mutations share the same lifecycle: show the "encoding in
// progress" banner, run the action, optionally toast + reload the state, then
// refresh the generation indicator — and on failure, toast the error and clear
// the banner. This factory captures that orchestration. The DOM side effects
// are injected via `ui`, so the logic is unit-tested in test/regen.test.js.
export function makeWithRegen(ui) {
  return async function withRegen(pendingTitle, action, { success = null, reload = true } = {}) {
    ui.showGenerationPending(pendingTitle);
    try {
      await action();
      if (success) ui.toast(success);
      if (reload) await ui.load();
      await ui.refreshGenerationStatus();
    } catch (e) {
      ui.toast(e.message);
      ui.clearGenerationPending();
    }
  };
}
