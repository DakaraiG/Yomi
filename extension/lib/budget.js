// The spend ceiling for unattended translation.
//
// Clicking the button is a decision to spend. Scrolling is not, and once pages
// translate on scroll the extension can spend money nobody asked it to: a brisk
// scroll through a twenty-page chapter is twenty requests. The cache makes
// re-reads free, so the exposure is only ever on the first pass -- but that is
// the difference between pennies and a surprise.
//
// THIS COUNTS PAID CALLS, NOT PAGES. A cache hit costs nothing and is never
// counted, so re-reading a chapter you have already read stays free however
// much you scroll. Manual translations are not counted either: the user asked
// for those.
//
// Synchronous by design. The check and the increment have to be one step --
// with a concurrency of three, an async gap between "is there budget" and
// "take some" lets three pages all pass a check that only one of them should.
// Persistence is the caller's problem, and is allowed to lag.

export const DEFAULT_LIMIT = 50;

export function createBudget(limit = DEFAULT_LIMIT) {
  let spent = 0;

  return {
    get spent() { return spent; },
    get limit() { return limit; },
    get remaining() { return Math.max(0, limit - spent); },

    setLimit(n) {
      if (Number.isFinite(n) && n >= 0) limit = Math.floor(n);
    },

    /** Restore a count persisted from an earlier worker lifetime. */
    restore(n) {
      if (Number.isFinite(n) && n > spent) spent = Math.floor(n);
    },

    /**
     * Take one paid translation, or refuse. Reserves BEFORE the call rather
     * than counting after it, so concurrent pages cannot overshoot together.
     */
    reserve() {
      if (spent >= limit) return false;
      spent++;
      return true;
    },

    /** Give a reservation back when the call never happened. */
    release() {
      if (spent > 0) spent--;
    },

    reset() { spent = 0; }
  };
}
