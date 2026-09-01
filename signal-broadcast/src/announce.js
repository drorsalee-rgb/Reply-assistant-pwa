// One announcement to every active fake-hunting volunteer.
//
// This exists because there was no honest way to do it. /api/notify is capped
// at five recipients and locked to an operator allowlist, deliberately, so
// that nobody can improvise a mass message to volunteers. Reaching nineteen
// people through it would have meant four batches and temporarily allowlisting
// volunteers — defeating the guard rather than respecting it. The answer to a
// guard that blocks a legitimate action is a proper door, not a way around it.
//
// It is NOT the alert pipeline. Alerts are drawn per post, per network, and
// per volunteer; this sends the same text to everyone. Announcements are rare
// and always operator-initiated: a new group, a change in how the tool works,
// an apology when something breaks.
//
// Three things stand between a typo and 19 people's phones:
//   - dry_run defaults to TRUE, so the harmless call is the one you get by
//     omitting the flag; a real send must be asked for in writing;
//   - `confirm` must repeat the recipient count the caller expects, so a pool
//     that grew since they looked refuses instead of surprising them;
//   - the message has a length cap and the recipient list is logged by last
//     four digits only.

const MAX_MESSAGE_CHARS = 1200;

/**
 * @param {object} body
 * @param {number} poolSize  how many active volunteers were actually found
 * @returns {{ok: true, message: string, dryRun: boolean}
 *          | {ok: false, status: number, error: string}}
 */
function validate(body, poolSize) {
  const { message, dry_run: dryRun = true, confirm } = body || {};

  if (typeof message !== 'string' || !message.trim()) {
    return { ok: false, status: 400, error: 'message is required' };
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, status: 400,
      error: `message is ${message.length} characters; the limit is ${MAX_MESSAGE_CHARS}` };
  }
  if (!poolSize) {
    return { ok: false, status: 400, error: 'no active volunteers to announce to' };
  }

  // A dry run needs no confirmation — it is the safe call, and asking for a
  // count before you have seen one is backwards.
  if (dryRun !== true) {
    if (confirm !== poolSize) {
      return { ok: false, status: 400,
        error: `a real send needs "confirm": ${poolSize} — the number of active volunteers `
          + 'this will reach right now. Run it with dry_run first to see the list.' };
    }
  }

  return { ok: true, message: message.trim(), dryRun: dryRun === true };
}

module.exports = { validate, MAX_MESSAGE_CHARS };
