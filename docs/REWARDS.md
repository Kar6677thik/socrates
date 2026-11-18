# Study rewards (Socrates → Hey Ann)

Real study in Socrates earns screen-time minutes in Hey Ann's wallet. This document is the **Socrates side**: what counts as study, how it's measured, and the events Socrates emits. Hey Ann's `docs/REWARDS.md` covers pricing, rates and wallet caps. The rules were agreed between the two app threads on 18 Nov 2026 and **approved by the owner**, together with Hey Ann's pricing (Hey Ann `docs/REWARDS.md` §10).

**Status:** Socrates computes the events and keeps them in an outbox (`reward_events`), visible at `GET /api/rewards`. Nothing is sent yet. The transport (a signed call or an event outbox using Orbit Identity client credentials) comes from Orbit's contract.

## The principle

An award comes only from facts the Socrates server holds: its own clocks, its own grading and the review schedule. Nothing an AI agent reports ("they studied for an hour") and nothing the browser reports can raise a figure.

- The browser sends `shown_at` and `time_ms` with each answer. Both can be edited, so neither is trusted. The browser's `time_ms` can only **lower** a credit.
- Server clocks: the session's `started_at` and each answer's `answered_at`.

Implementation: `src/core/rewards.ts` (`RULES` holds every number below). Tests: `tests/second-brain.test.ts`.

## `study_minutes`: time spent answering

**Credit per answer.** The server's gap since the previous answer in the same session (or since the session started):
- capped at **3 min**, or **6 min** for written answers and code;
- **0** if the gap is over **10 min** (idle);
- never more than the browser's own `time_ms`.

**Which answers count:**
- a **due review**: the card was due when it was answered;
- a **never-seen** question;
- a question answered **wrong in the last 24 h**.

**Which never count:**
- re-answering a question already answered correctly in the last 24 h;
- a question created less than 24 h before the answer. This stops "write easy questions, then answer them".
- an undone answer: undo deletes the attempt;
- sessions started before rewards were switched on.

**Weight by who graded:**

| Grading | Weight |
|---|---|
| Server-graded (choices, true/false, numeric, cloze, matching, ordering, hotspot, code with tests) | 100% |
| Written answer graded by an agent through `submit_grades` | 100% |
| Flashcards and self-graded written answers | 50% |
| Still ungraded | 0 |

**When:** an event is emitted once the session is **closed**: you ended it, or 30 min passed since its last answer, so undo and grading have settled.
- A session with ungraded written answers waits up to **48 h**, then is emitted without them.
- If those answers are graded later, **one** supplement follows with only the extra minutes.

**Sanity limit:** at most **180 study minutes** per study day. Hey Ann's own caps are much lower.

## `mastery_up`: crossing a mastery level

- **Thresholds:** 50%, 70% and 85% mastery (calibrated probability of answering an average-difficulty question correctly).
- **Each pays once per tag, ever.** Falling back and rising again pays nothing.
- **Leaf tags only,** so a parent never pays again for its children's progress.
- **Evidence needed:** at least **10** graded answers in the tag, on questions older than 24 h, across at least **2** study days.
- **No windfall at launch:** when rewards are switched on, levels already reached are recorded as a baseline and never paid.

## Events

Every event has an idempotent `event_id`; the receiver dedupes on it.

```json
{ "event_id": "socrates:study:412", "kind": "study_minutes", "day": "2026-11-18", "occurred_at": 1763460000000,
  "minutes": 6.5, "intervals": [[1763459100000, 1763459280000], [1763459400000, 1763459700000]],
  "session_id": 412, "attempts_credited": 4, "pending": 0 }

{ "event_id": "socrates:study:412:late", "kind": "study_minutes", "supplement": true, "minutes": 5, … }

{ "event_id": "socrates:mastery:37:70", "kind": "mastery_up", "day": "2026-11-18", "occurred_at": 1763460000000,
  "tag": { "id": 37, "path": "math/calculus/integrals", "title": "integrals" }, "threshold": 70 }
```

- **`day`** is Socrates' study day: the owner's local date (the `TZ` setting), rolling over at **04:00**. Use it as given.
- **`intervals`** are the credited stretches, merged, in epoch milliseconds. Hey Ann voids exactly the parts that overlap a running focus timer or a phone spend session.
- **`minutes`** is never more than the total of `intervals`. It can be less, because of the 50% weight and the daily limit.

## Hey Ann's pricing (its side, for reference)

- `study_minutes` × 0.25, the same rate as card focus time.
- `mastery_up` pays +3, at most 3 a day.
- Study earnings count toward the 60/day wallet cap, with a sub-cap of 30/day from study.
