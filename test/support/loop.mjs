/**
 * Hold the event loop open for the duration of a test.
 *
 * Every timer in this plugin is `unref`'d on purpose (`src/connection/channel.ts`
 * schedules the channel deadline that way, and `src/sftp/progress.ts` says so
 * outright): a plugin's background work must never be a reason for the DSH
 * process to stay alive. In production something else is always pending — the SSH
 * socket alone is a held handle — so a deadline still fires on time.
 *
 * A test process has no such guarantee. When the awaited deadline is the only
 * pending work, the loop drains, and Node 20/22's test runner ends the file with
 *
 *     Promise resolution is still pending but the event loop has already resolved
 *
 * which cancels that test and every test after it in the file. Node 24's runner
 * happens to hold a handle, so this passed on a developer machine and failed on
 * CI — the failure said nothing about the code under test.
 *
 * Awaiting a real deadline is a legitimate thing to test, so the test holds the
 * loop itself instead of depending on which runner is in use. The sentinel is
 * cleared on teardown, and it is bounded, so a hung test still ends.
 *
 * Pass the test context and the sentinel is cleared when that test ends. For a
 * file with several such cases, omit it and clear the returned timer from an
 * `afterEach` hook instead.
 */
export function holdLoop(t, ms = 10_000) {
  const timer = setTimeout(() => {}, ms)
  if (t !== undefined) t.after(() => clearTimeout(timer))
  return timer
}
