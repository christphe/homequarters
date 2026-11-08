// The raised hand's toggle (H and the hand button). Pure so it can be tested without a browser.

/** How long a hand request the server has not confirmed yet still counts (one dropped by the rate limit stops counting). */
export const HAND_PENDING_MS = 1000;

/**
 * What a press asks for: the opposite of the last request while the server has not confirmed it yet,
 * else of what the server says; so two quick presses are a raise and a lower, not two raises.
 */
export function nextHand(raised: boolean, wanted: boolean | null, askedAt: number, now: number): boolean {
  const pending = now - askedAt < HAND_PENDING_MS ? wanted : null;
  return !(pending ?? raised);
}
