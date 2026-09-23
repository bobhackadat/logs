/**
 * Maximum Power Even/Odd Engine — "Pattern Flip Disruptor" decision core.
 *
 * Pure, deterministic helpers shared by the auto-trading hook:
 *  - rolling last-N-ticks digit window (real-time WebSocket tick history)
 *  - consecutive even/odd streak detection + mathematical variance between
 *    consecutive digit streaks
 *  - per-tick contract-direction decision (fires on EVERY tick):
 *      * 3+ consecutive EVENS  -> fire an ODD contract next tick (reversion)
 *      * 3+ consecutive ODDS   -> fire an EVEN contract next tick (reversion)
 *      * otherwise             -> sum of the last 2 digits: even sum -> EVEN,
 *                                 odd sum  -> ODD (continuous offensive pressure)
 */

export type DigitParity = 'even' | 'odd';
export type EngineDirection = 'DIGITEVEN' | 'DIGITODD';

export interface StreakInfo {
  /** Parity of the current trailing streak in the window. */
  parity: DigitParity;
  /** Length of that trailing streak. */
  length: number;
}

export interface PatternFlipDecision {
  direction: EngineDirection;
  reason: string;
  /** Trailing even/odd streak active when the decision was made. */
  streak: StreakInfo;
  /** Mathematical variance between consecutive digit streaks in the window. */
  streakVariance: number;
}

/** A single trade tracked by the engine dashboard. */
export interface EngineTrade {
  contractId: number;
  direction: EngineDirection;
  stake: number;
  /** Martingale level at which this trade was placed (0 = base stake). */
  level: number;
  epoch: number;
  status: 'open' | 'won' | 'lost';
  profit: number;
}

/** Extract the last quote digit from a price using the symbol's pip size. */
export function digitFromQuote(quote: number, pipSize: number): number {
  const str = quote.toFixed(pipSize);
  const d = parseInt(str[str.length - 1], 10);
  return Number.isNaN(d) ? 0 : d;
}

/** Build the rolling digit window for the last `windowSize` ticks. */
export function buildDigitWindow(prices: number[], pipSize: number, windowSize = 10): number[] {
  return prices.slice(-windowSize).map((p) => digitFromQuote(p, pipSize));
}

/** Parity of a digit. */
export function parityOf(digit: number): DigitParity {
  return digit % 2 === 0 ? 'even' : 'odd';
}

/** Trailing even/odd streak of the digit window (parity + length). */
export function getStreak(digits: number[]): StreakInfo {
  if (digits.length === 0) return { parity: 'even', length: 0 };
  const parity = parityOf(digits[digits.length - 1]);
  let length = 0;
  for (let i = digits.length - 1; i >= 0 && parityOf(digits[i]) === parity; i--) {
    length++;
  }
  return { parity, length };
}

/**
 * Immediate mathematical variance between consecutive digit streaks:
 * split the window into maximal same-parity runs and compute the population
 * variance of the run-length sequence. Zero when only one streak exists.
 */
export function streakVariance(digits: number[]): number {
  const runs: number[] = [];
  let current = 0;
  let parity: DigitParity | null = null;
  for (const d of digits) {
    const p = parityOf(d);
    if (p !== parity) {
      if (current > 0) runs.push(current);
      parity = p;
      current = 1;
    } else {
      current++;
    }
  }
  if (current > 0) runs.push(current);
  if (runs.length < 2) return 0;
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  return runs.reduce((acc, r) => acc + (r - mean) ** 2, 0) / runs.length;
}

/** Heavy-streak threshold that triggers the Pattern Flip reversion entry. */
export const PATTERN_FLIP_STREAK = 3;

/**
 * The Pattern Flip Disruptor entry logic — returns the contract to fire on the
 * NEXT tick given the current rolling digit window.
 */
export function decideNextContract(digits: number[]): PatternFlipDecision | null {
  if (digits.length === 0) return null;

  const streak = getStreak(digits);
  const variance = streakVariance(digits);

  // Offensive reversion: a heavy 3+ streak is instantly flipped against.
  if (streak.length >= PATTERN_FLIP_STREAK) {
    return {
      direction: streak.parity === 'even' ? 'DIGITODD' : 'DIGITEVEN',
      reason:
        streak.parity === 'even'
          ? `Pattern Flip: ${streak.length} consecutive EVENS -> ODD`
          : `Pattern Flip: ${streak.length} consecutive ODDS -> EVEN`,
      streak,
      streakVariance: variance,
    };
  }

  // No heavy streak: last-2-digit sum keeps continuous offensive market
  // pressure — every tick gets a contract, no tick opportunity is missed.
  const lastTwo = digits.slice(-2);
  const sum = lastTwo.reduce((a, b) => a + b, 0);
  return {
    direction: sum % 2 === 0 ? 'DIGITEVEN' : 'DIGITODD',
    reason: `Last-2 sum ${sum} is ${sum % 2 === 0 ? 'EVEN' : 'ODD'} -> ${sum % 2 === 0 ? 'EVEN' : 'ODD'} contract`,
    streak,
    streakVariance: variance,
  };
}
