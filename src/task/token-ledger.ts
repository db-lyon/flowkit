/**
 * A shared token ledger for agent runs.
 *
 * A budget that only counts an agent's own turns is no budget at all once that
 * agent fans out: a tree of sub-agents can spend N times over while each frame
 * sees only its own slice. The ledger fixes that. One budgeted agent creates a
 * ledger; every descendant shares it by reference and charges the same counter,
 * so the cap is a true ceiling over the whole subtree.
 *
 * Ledgers chain via `parent`, so an inner agent can hold a tighter sub-budget
 * while every charge still rolls up to its ancestors' ceilings. A charge is
 * exhausted when ANY frame in the chain has reached its limit.
 */
export interface TokenLedger {
  /** Token ceiling for this frame. `0` means unbounded at this frame. */
  limit: number;
  /** Tokens charged to this frame so far (input + output). */
  spent: number;
  /** Enclosing budget frame, if any. Charges roll up through it. */
  parent?: TokenLedger;
}

/** Open a new budget frame nested under `parent` (if any). */
export function createLedger(limit: number, parent?: TokenLedger): TokenLedger {
  return { limit, spent: 0, parent };
}

/** Charge `tokens` to a frame and every ancestor frame. */
export function chargeLedger(ledger: TokenLedger | undefined, tokens: number): void {
  for (let cur = ledger; cur; cur = cur.parent) cur.spent += tokens;
}

/** True when any frame in the chain has reached its limit. */
export function ledgerExhausted(ledger: TokenLedger | undefined): boolean {
  return exhaustedLimit(ledger) !== undefined;
}

/**
 * The limit of the nearest exhausted frame, or `undefined` if none is. Used for
 * a precise failure message ("exceeded token budget (N)").
 */
export function exhaustedLimit(ledger: TokenLedger | undefined): number | undefined {
  for (let cur = ledger; cur; cur = cur.parent) {
    if (cur.limit > 0 && cur.spent >= cur.limit) return cur.limit;
  }
  return undefined;
}
