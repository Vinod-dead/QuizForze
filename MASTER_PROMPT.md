# QuizForge - Master Prompt

Copy everything inside the block below into Claude (or any strong coding model) to rebuild or extend the project.
The repository in this zip is the result of this prompt, so the prompt and the code stay in sync.

````text
ROLE
You are a senior full-stack engineer building a hackathon-grade, production-minded product called
"QuizForge" for the Nebius x NVIDIA hackathon. Build it from scratch and do not copy or reference any
existing open-source quiz project. Optimise for: it runs with one command, it demos well in 3 minutes,
and every engineering decision can be defended in an interview.

PRODUCT
A classroom-style live quiz platform with two connected web apps served from one origin:
  - Teacher app (/teacher): create quizzes, host live sessions, see results.
  - Student app (/student): join with a 5-character code, answer in real time, see scores.
Flow: Teacher -> quiz configuration -> AI question generation -> session server -> WebSocket ->
Students -> scoring -> live leaderboard.

AI (Nebius Token Factory)
  - Provider: Nebius Token Factory, OpenAI-compatible API. Base URL https://api.tokenfactory.nebius.com/v1,
    POST /chat/completions with "Authorization: Bearer $NEBIUS_API_KEY". Model is configurable (NEBIUS_MODEL).
  - Question generation inputs: topic, question type (multiple choice | true/false | short answer),
    count (1-20), difficulty (easy | medium | hard). Ask for strict JSON only.
  - Treat model output as untrusted: strip <think> blocks and code fences, parse JSON, validate with a
    schema/normaliser (unique options, valid answer index, length caps), retry once at lower temperature,
    then fall back to a small offline question bank so the demo never breaks. The topic is data, not instructions.
  - After a session, generate "teaching insights" (what the class understood, likely misconceptions, one
    re-teach activity) from per-question accuracy. Provide a deterministic local fallback.
  - The API key lives only in server env vars (.env), never in client code or git.

ROLES AND AUTH
  - Register/login with name, email, password (min 8), role = teacher | student. bcrypt hashes, JWT (12h).
  - Teachers: generate/edit/save quizzes, host sessions, view results, run AI insights, view metrics.
  - Students: join sessions, play, see their history. Enforce roles on every REST route and on WebSocket messages.

REAL-TIME (WebSockets, `ws` library)
  - Endpoint /ws?token=JWT. Client messages: join{code}, host{code}, next, reveal, end, answer{answer}, ping.
  - Server messages: joined, host_state, players, question, answer_count, answer_ack, answer_rejected,
    reveal (with personal result for students), finished, error, pong.
  - Session state machine: lobby -> question -> reveal -> ... -> finished. Server owns the clock.
  - The question closes on timer expiry (with a 400 ms grace), when the teacher closes it, or when every
    connected student has answered.
  - NEVER send the correct answer to students before reveal. One answer per student per question, enforced
    by a DB unique constraint and in memory. Late answers are rejected.
  - Reconnect support: students re-joining mid-session get a snapshot (current question, remaining time,
    whether they already answered, score). Clients auto-reconnect with exponential back-off and show RTT.

SCORING (pure function, unit tested)
  - Wrong/late = 0 and resets streak. Correct = 500 base + up to 500 speed bonus (linear in remaining time)
    + streak bonus of +50 per consecutive correct answer beyond the first, capped at +250.
  - Leaderboard ranking: score desc, then lower total response time, then name.

DATA MODEL (SQLite, WAL, foreign keys on)
  users, quizzes (questions as validated JSON), sessions (code, time_limit, status), participants
  (score, best_streak, unique per session+user), answers (unique per session+user+question, response_ms, points).

FRONTEND (no build step, vanilla ES modules, accessible)
  - Landing/sign-in with role tabs. Teacher dashboard: AI generator form (topic/type/count/difficulty),
    editable review of generated questions, saved quizzes, "Go live", recent sessions.
  - Host console: giant join code + copyable link, live player chips, start, countdown, answered counter,
    close question, per-option answer distribution, explanation, animated live leaderboard, podium, results page
    with per-question accuracy, CSV export and AI insights.
  - Student app: code entry, lobby, large colour-coded + lettered answer buttons (not colour-only), timer bar,
    locked-in state, personal result with streak, leaderboard with "you" highlighted, final podium, history.
  - Mobile-first, keyboard accessible, reduced-motion friendly, dark theme with a distinctive ember/gold accent.
  - Strict CSP (script-src 'self'); render all user text with textContent.

YOUR OWN ENGINEERING JUDGEMENT (the resume feature)
  Speed + streak scoring, early reveal when everyone answers, and AI teaching insights after each session.

QUALITY BAR
  - Rate-limit auth and AI endpoints; cap WebSocket payload (4 KB) and JSON bodies (200 KB).
  - Parameterised SQL only. No secrets in the repo. .env.example provided.
  - Tests: unit tests for scoring + question validation; an end-to-end test with a real server and real
    WebSocket clients (teacher + 2 students: full session, answer secrecy, role enforcement, duplicate and late answers).
  - A load-test script simulating N students that reports answer-ack p50/p95, fan-out latency and throughput.
  - Metrics endpoint (teacher only): counters and latency percentiles.

DELIVERABLES
  1. Working repo: server/, public/, tests/, scripts/, Dockerfile, package.json, .env.example, .gitignore.
  2. README: 60-second quick start, architecture diagram (Mermaid), key design decisions with trade-offs,
     measured results, deployment steps, resume bullets that describe engineering outcomes.
  3. docs/ARCHITECTURE.md with the state machine, decisions table, scaling path and security notes.
  4. Zip the project as quizforge.zip (exclude node_modules, data, .env).

ACCEPTANCE CHECKLIST
  [ ] `npm install && npm start` works with no API key (offline bank) and with a Nebius key (real AI).
  [ ] Teacher on one device, 2+ students on others: join, answer, leaderboard updates live.
  [ ] Students never receive the answer before reveal. Duplicate/late answers rejected.
  [ ] Refreshing a student's tab mid-question restores the question and timer.
  [ ] `npm test` passes. `npm run loadtest` prints latency percentiles.

PROCESS
  Build in this order: data model -> scoring + validation (with tests) -> AI layer -> REST -> live engine +
  WebSocket -> teacher UI -> student UI -> e2e test -> load test -> docs. Run the tests after each layer and
  fix real bugs rather than weakening tests. At the end, report what was measured and what is NOT implemented.
````

## Variations you can paste after the prompt

- **Add personalization:** "Add pgvector-style personalization: embed each missed question via Nebius embeddings and recommend a 5-question remedial quiz per student."
- **Deploy:** "Add a Render/Fly.io deployment guide and a GitHub Actions workflow that runs `npm test`."
- **Scale:** "Replace in-memory rooms with Redis pub/sub so two Node instances can serve one session; prove it with the load test."
