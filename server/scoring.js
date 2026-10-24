// Pure scoring logic (unit-tested). Server-authoritative: elapsed time is measured by the server.
export const BASE_POINTS = 500;
export const SPEED_POINTS = 500;
export const STREAK_STEP = 50;
export const STREAK_CAP = 5;

/**
 * Points for one answer.
 * - wrong / late answers score 0 and reset the streak
 * - correct: 500 base + up to 500 speed bonus (linear in remaining time)
 * - streak bonus: +50 per consecutive correct answer beyond the first, capped at +250
 */
export function scoreAnswer({ correct, elapsedMs, timeLimitMs, prevStreak }) {
  if (!correct) return { points: 0, streak: 0, speedBonus: 0, streakBonus: 0 };
  const ratio = Math.min(1, Math.max(0, elapsedMs / timeLimitMs));
  const speedBonus = Math.round(SPEED_POINTS * (1 - ratio));
  const streak = prevStreak + 1;
  const streakBonus = Math.min(streak - 1, STREAK_CAP) * STREAK_STEP;
  return { points: BASE_POINTS + speedBonus + streakBonus, streak, speedBonus, streakBonus };
}

/** Sort: score desc, then lower total response time, then name. */
export function rankPlayers(players) {
  return [...players]
    .sort((a, b) => b.score - a.score || a.totalMs - b.totalMs || a.name.localeCompare(b.name))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}
