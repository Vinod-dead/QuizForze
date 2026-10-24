// Question schema, normalisation and grading. Everything the AI returns passes through here.
export const TYPES = ['mcq', 'true_false', 'short_answer'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const clean = (s, max = 400) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function normalizeAnswerText(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** Returns a valid question or null. Accepts loose AI output. */
export function normalizeQuestion(raw, forcedType) {
  if (!raw || typeof raw !== 'object') return null;
  const text = clean(raw.text ?? raw.question);
  if (text.length < 5) return null;
  const type = TYPES.includes(forcedType) ? forcedType : TYPES.includes(raw.type) ? raw.type : 'mcq';
  const explanation = clean(raw.explanation, 600);

  if (type === 'true_false') {
    let a = raw.answer;
    if (typeof a === 'string') a = a.trim().toLowerCase() === 'true' || a.trim() === '0';
    if (typeof a === 'number') a = a === 0; // index 0 === "True"
    if (typeof a !== 'boolean') return null;
    return { type, text, options: ['True', 'False'], answer: a ? 0 : 1, explanation };
  }

  if (type === 'short_answer') {
    const accepted = (Array.isArray(raw.accepted) ? raw.accepted : [raw.answer])
      .map((x) => clean(x, 80)).filter(Boolean);
    if (!accepted.length) return null;
    return { type, text, options: [], accepted: [...new Set(accepted)].slice(0, 6), explanation };
  }

  const options = (Array.isArray(raw.options) ? raw.options : []).map((o) => clean(o, 200)).filter(Boolean);
  if (options.length < 2 || options.length > 6 || new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  let answer = raw.answer;
  if (typeof answer === 'string' && /^[A-F]$/i.test(answer.trim())) answer = answer.trim().toUpperCase().charCodeAt(0) - 65;
  else if (typeof answer === 'string' && /^\d+$/.test(answer.trim())) answer = Number(answer);
  else if (typeof answer === 'string') answer = options.findIndex((o) => o.toLowerCase() === answer.trim().toLowerCase());
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
  return { type: 'mcq', text, options, answer, explanation };
}

export function normalizeQuestions(list, forcedType, max = 30) {
  return (Array.isArray(list) ? list : []).map((q) => normalizeQuestion(q, forcedType)).filter(Boolean).slice(0, max);
}

/** Grade a submitted answer. `submitted` is an option index (choice types) or a string (short answer). */
export function gradeAnswer(q, submitted) {
  if (q.type === 'short_answer') {
    const s = normalizeAnswerText(submitted);
    return s.length > 0 && q.accepted.some((a) => normalizeAnswerText(a) === s);
  }
  return Number.isInteger(submitted) && submitted === q.answer;
}

/** What students may see before the reveal (never includes the answer). */
export function publicQuestion(q, index, total) {
  return { index, total, kind: q.type, text: q.text, options: q.options };
}

export function correctAnswerLabel(q) {
  return q.type === 'short_answer' ? q.accepted[0] : q.options[q.answer];
}
