import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswer, rankPlayers } from '../server/scoring.js';
import { normalizeQuestion, gradeAnswer } from '../server/questions.js';

test('wrong answer scores 0 and resets streak', () => {
  assert.deepEqual(scoreAnswer({ correct: false, elapsedMs: 1000, timeLimitMs: 20000, prevStreak: 4 }), { points: 0, streak: 0, speedBonus: 0, streakBonus: 0 });
});
test('instant correct answer gets 1000, no streak bonus on first', () => {
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 0, timeLimitMs: 20000, prevStreak: 0 }).points, 1000);
});
test('last-second correct answer gets base 500', () => {
  assert.equal(scoreAnswer({ correct: true, elapsedMs: 20000, timeLimitMs: 20000, prevStreak: 0 }).points, 500);
});
test('streak bonus grows and caps at +250', () => {
  const b = (prev) => scoreAnswer({ correct: true, elapsedMs: 20000, timeLimitMs: 20000, prevStreak: prev }).streakBonus;
  assert.deepEqual([b(0), b(1), b(2), b(5), b(9)], [0, 50, 100, 250, 250]);
});
test('ranking: score, then faster total time, then name', () => {
  const r = rankPlayers([{ name: 'B', score: 10, totalMs: 5 }, { name: 'A', score: 10, totalMs: 9 }, { name: 'C', score: 20, totalMs: 99 }]);
  assert.deepEqual(r.map((p) => p.name), ['C', 'B', 'A']);
  assert.deepEqual(r.map((p) => p.rank), [1, 2, 3]);
});
test('normalizeQuestion accepts letter answers and rejects duplicates / bad index', () => {
  assert.equal(normalizeQuestion({ text: 'Pick the right one', options: ['a', 'b', 'c', 'd'], answer: 'C' }).answer, 2);
  assert.equal(normalizeQuestion({ text: 'Pick the right one', options: ['a', 'a', 'c', 'd'], answer: 0 }), null);
  assert.equal(normalizeQuestion({ text: 'Pick the right one', options: ['a', 'b'], answer: 5 }), null);
});
test('true/false and short answer grading', () => {
  const tf = normalizeQuestion({ text: 'The sky is blue.', answer: true }, 'true_false');
  assert.equal(gradeAnswer(tf, 0), true); assert.equal(gradeAnswer(tf, 1), false);
  const sa = normalizeQuestion({ text: 'Which language runs in browsers?', accepted: ['JavaScript', 'JS'] }, 'short_answer');
  assert.equal(gradeAnswer(sa, '  javascript! '), true); assert.equal(gradeAnswer(sa, 'python'), false);
});
