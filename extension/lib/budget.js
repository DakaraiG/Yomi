// The spend ceiling for unattended translation: scrolling is not a decision to
// spend, and a brisk scroll through a chapter is twenty requests.
//
// Counts paid calls, not pages. Cache hits cost nothing and are never counted,
// and neither are manual translations, which the user asked for.
//
// Synchronous by design: the check and the increment must be one step, or with a
// concurrency of three all three pages pass a check only one should. Persistence
// is the caller's problem and is allowed to lag.

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
     * Take one paid translation, or refuse. Callers reserve before the call
     * rather than counting after it, so concurrent pages cannot overshoot.
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
