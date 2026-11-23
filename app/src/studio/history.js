// The one append-only handoff log. Every module writes through here, so "who did what" has one
// shape and one cap, and history cannot be edited in place from two directions.

const CAP = 400;

export function pushHistory(f, event) {
  if (!event.at) event.at = new Date().toISOString();
  f.history.push(event);
  if (f.history.length > CAP) f.history.splice(0, f.history.length - CAP);
  return event;
}

export const HISTORY_CAP = CAP;
