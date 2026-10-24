// Tiny in-process metrics: counters + latency histograms (ring buffers) for the resume-worthy numbers.
const RING = 500;
const rings = new Map();
const counters = new Map();

export function observe(name, ms) {
  let r = rings.get(name);
  if (!r) rings.set(name, (r = []));
  r.push(ms);
  if (r.length > RING) r.shift();
}
export function inc(name, n = 1) { counters.set(name, (counters.get(name) || 0) + n); }
export function timer(name) { const t = process.hrtime.bigint(); return () => observe(name, Number(process.hrtime.bigint() - t) / 1e6); }

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export function snapshot() {
  const latency = {};
  for (const [k, v] of rings) {
    const s = [...v].sort((a, b) => a - b);
    latency[k] = { count: s.length, p50: +pct(s, 50).toFixed(2), p95: +pct(s, 95).toFixed(2), max: +(s[s.length - 1] || 0).toFixed(2) };
  }
  return { uptimeSec: Math.round(process.uptime()), counters: Object.fromEntries(counters), latencyMs: latency };
}
