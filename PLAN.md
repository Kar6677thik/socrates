# Socrates — Plan

Personal, local-first quiz and testing platform. One user, no auth. Effort goes into speed, UX and the engine.

---

## 1. Research summary

| Tool | Best at | Borrow |
|---|---|---|
| **Anki + FSRS** | Scheduling. FSRS models each card's *difficulty, stability, retrievability* and fits its weights to your own review log. | FSRS-6 via `ts-fsrs`, with weights re-fit from my history. Retention target is a single slider. |
| **RemNote** | Hierarchical concepts; cards are part of a knowledge tree. | The tag hierarchy *is* the knowledge tree. Mastery rolls up from leaf tags to parents. |
| **Quizlet** | Low-friction creation, many study modes over one set. | One question pool with many modes (practice, timed, exam, SRS); a mode is just a different session config. |
| **Brainscape** | Confidence-based repetition (rate 1–5). | Optional confidence rating on every attempt. It feeds calibration analytics (overconfident and wrong is the most important signal). |
| **Mochi** | Minimal, markdown-native, keyboard-driven, fast. | Visual tone: markdown everywhere, a quiet UI, keyboard-first. |
| **Duolingo (Birdbrain / HLR)** | Estimates P(correct) per learner × item and picks items near a target difficulty. | Elo/IRT-style ability per tag and difficulty per question, updated after every attempt. Next items are chosen near ~70–85% predicted success. |
| **UWorld** | Exam simulation: timed blocks, flagging, then review with explanations and percentile stats. | Exam mode: block timer, flag, navigator grid, no feedback until the end, then a review screen. |
| **LeetCode** | Code questions, tagging by topic, difficulty labels, progress per topic. | Code question type with an editor. Per-tag progress bars. |

**Main takeaway:** combine FSRS (*when* to review) with Elo/IRT (*what* is the right difficulty and where I am weak). Neither covers both, and most tools only do one.

---

## 2. Stack (local-first, one command to run)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node 22 + pnpm**, TypeScript end to end | Reliable on Windows; one language for the web app, the API and MCP. |
| DB | **SQLite** (`better-sqlite3`, WAL) + **Drizzle** | Embedded, a single file, synchronous and very fast. FTS5 handles search. Backup is copying one file. |
| Server | **Hono** | Small and fast. One process serves the API, the built UI and the MCP HTTP endpoint. |
| UI | **Vite + React 19 + TanStack Router/Query** | Instant HMR, typed routes, optimistic updates so interactions feel immediate. |
| Styling | **Tailwind v4** + a small set of my own components (Radix primitives) | Full control over a restrained look. |
| Content | `markdown-it` + **KaTeX** + **Shiki**, **CodeMirror 6** for code input | All render fast on the client. |
| Charts | **uPlot** (time series) + plain SVG (heatmaps) | Tiny and fast; easy to keep monochrome. |
| Scheduling | **ts-fsrs** | Reference FSRS implementation, includes the optimizer. |
| Similarity | Trigram/Jaro-Winkler (tags), FTS5 + **local embeddings** (`transformers.js`, MiniLM) for questions | Offline, no API keys. |
| MCP | **@modelcontextprotocol/sdk**: stdio (Claude Desktop/Code) + Streamable HTTP (ChatGPT) | Both clients supported. ChatGPT needs a public HTTPS URL, so it goes through a tunnel (cloudflared). |

Run: `pnpm i && pnpm dev`, then open `localhost:4321`. Data lives in `./data/socrates.db`.

### Design direction
Neutral greyscale (zinc) with **one** muted accent used only for focus and the primary action. Green and red appear only for correct/incorrect, and desaturated. Inter for text, JetBrains Mono for code. Generous whitespace, 1px borders and no shadows. Dark mode is the default with a light toggle. Motion is ≤150ms and only signals state changes.

---

## 3. Data model (core tables)

```
tags            id, name, slug(normalized), parent_id, path ("math/calculus/integrals"),
                description, created_by(user|agent), merged_into_id
tag_aliases     tag_id, alias_slug              -- synonyms, abbreviations, plural forms
questions       id, type, prompt_md, payload_json (type-specific: options, pairs, order,
                tolerance, test cases…), answer_json, explanation_md, rubric_json,
                hints_json, difficulty_seed, irt_b (calibrated difficulty), source,
                embedding BLOB, content_hash, status(draft|active|suspended|archived),
                version, client_ref (idempotency key from the agent), flagged_reason
question_versions question_id, version, snapshot_json, edited_at  -- attempts point at a version
question_tags   question_id, tag_id
fsrs_cards      question_id, stability, difficulty, due, state, reps, lapses, last_review
sessions        id, mode, config_json, started_at, ended_at
attempts        id, question_id, session_id, response_json, is_correct, score(0–1),
                grade_status(auto|pending|graded), confidence(1–4), hints_used,
                time_ms, first_input_ms (hesitation), answer_changes, shown_at,
                answered_at, local_hour, weekday, rating(FSRS 1–4)
attempt_events  attempt_id, t_ms, kind(focus|blur|change|hint|flag), data_json
grades          attempt_id, score, feedback_md, rubric_scores_json, grader(agent id)
ability         tag_id, theta, n, updated_at    -- Elo/IRT ability per tag
```

Every keystroke-level signal lands in `attempt_events`; `attempts` holds the derived summary so analytics queries stay cheap.

---

## 4. Question types

Auto-graded: MCQ single, MCQ multi (partial credit), true/false, fill-in-the-blank (multiple blanks, accepted variants, regex, case and whitespace rules), numeric (tolerance, units, significant figures), matching, ordering (partial credit by Kendall tau), cloze (Anki style), hotspot on an image (click a region), code with output/test cases (JS runs in a Web Worker; other languages go to the agent).
Agent-graded: short answer, long answer/essay, code review/explain, free-form proofs.
Self-graded fallback: flashcard (reveal, then rate Again/Hard/Good/Easy).

Each type is one module with a schema (zod), a renderer, an input component, a grader and keyboard bindings. New types plug in without touching the core.

---

## 5. Tagging rules (enforced on the server, not left to the agent's good behaviour)

1. **Normalization:** lowercase, trim, NFKD with diacritics stripped, `&`→`and`, collapse separators, singularize the last word. `"Integrals "`, `integral` and `INTEGRALS` all map to the same slug.
2. **Resolution order** when a tag is given: exact slug → alias → fuzzy (Jaro-Winkler ≥ 0.92 or trigram ≥ 0.6 within the same parent) → embedding similarity on name + description.
3. **`create_tag` refuses** when step 2 finds a candidate. It returns the candidates and requires `force: true` together with a `justification`. Forced creations are logged so I can review them.
4. `add_question` accepts tag *paths*. Unknown paths are resolved through the same pipeline and never silently created.
5. Merge and alias tools: `merge_tags(a → b)` re-points questions and leaves an alias behind, so old names keep resolving.
6. **Question dedup:** content hash (exact) + FTS5 prefilter + embedding cosine. Above 0.92 the question is rejected as a duplicate; from 0.85 to 0.92 it is accepted but flagged "near duplicate" with links to the matches.

---

## 6. MCP tool design

Resources/tools are grouped and every response is compact JSON. Tools that write accept arrays (bulk is the default; a single item is an array of one).

**Tags:** `get_tag_tree` (full tree with counts, aliases and mastery; *the tool descriptions tell the agent to call this first*), `resolve_tags(names[])` (dry run that shows what each name would map to), `create_tag`, `add_alias`, `merge_tags`, `move_tag`.
**Questions:** `add_questions(items[], dry_run?)` (returns created / duplicates / tag-resolution report), `update_question`, `search_questions(query, tags, type, difficulty)`, `get_question`, `set_status` (suspend/archive), `check_duplicate`.
**Grading:** `list_pending_grades`, `get_attempt_for_grading` (prompt, rubric, model answer, my response), `submit_grade(attempt_id, score, rubric_scores, feedback_md)`. The connected LLM is the grader, so the server needs no API key.
**Performance:** `get_performance_summary(tag?, window?)`, `get_weak_areas(limit)` (low θ, high lapse rate, overconfidence), `get_tag_stats(tag)`, `get_recent_mistakes(tag?)` (includes my wrong answers so the agent can target misconceptions), `get_coverage_gaps` (tags with few questions or few difficulty levels).
**Sessions:** `create_quiz(config)` returns a link the UI opens.
**Prompts:** `generate_targeted_questions(tag)` and `grade_pending` as MCP prompts that chain the tools in the right order.

---

## 7. Adaptive engine

- **FSRS** gives `due` and retrievability R for every reviewed question. Ratings come from correctness + time + confidence + hints (for example, correct but slow or with a hint → Hard; correct, fast and confident → Easy). I can override the rating.
- **Elo/IRT:** each attempt updates question difficulty `b` and tag ability `θ` for every tag on the question (weighted toward leaf tags). This calibrates difficulty from real performance, not from the seed label.
- **Next-item selection** scores candidates on a weighted mix: overdue-ness (1−R), tag weakness (low θ, lapses), how close predicted P(correct) is to the target (~0.8), novelty (never seen), and interleaving (penalize the same tag twice in a row). Each mode changes the weights: SRS uses mostly due items, Weak areas uses mostly weakness, Exam uses a fixed blueprint.
- **Recommendations:** "Study next" cards on the home screen, such as due count, three weakest tags, decaying tags (R falling), and overconfidence hotspots.
- FSRS weights are re-optimized weekly once there are enough reviews (≥ 400).

---

## 8. UI screens

- **Home:** due today, streak, recommended sessions, a heat calendar. `Enter` starts the recommended session.
- **Quiz runner:** full focus with one question at a time. Keys: `1–9` choose, `Space/Enter` submit or next, `H` hint, `F` flag, `C` confidence, `E` edit question, `?` help.
- **Quiz builder:** tag tree multi-select, type/difficulty filters, mode, count, time limit. Presets can be saved.
- **Library:** question table with fast filtering (virtualized), inline edit, tag tree editor (merge/alias by drag and drop).
- **Analytics:** weakest tags, accuracy over time per tag/type/difficulty, speed vs. accuracy scatter, forgetting curves (predicted R vs. actual), confidence calibration, time-of-day performance.
- **Command palette** (`Ctrl+K`) for everything.

---

## 9. Phases

**Phase 1 — MVP (MCP and tagging done right)**
Monorepo scaffold, SQLite schema + migrations, the full tag pipeline (normalize/alias/fuzzy/merge), question dedup (hash + FTS + embeddings), MCP server (stdio + HTTP) with the tag, question and grading tools. Question types: MCQ single/multi, true/false, fill-in-the-blank, numeric, short answer, flashcard. Practice and SRS modes using FSRS. Attempt tracking (time, changes, hesitation, confidence, hints). Markdown/KaTeX/code rendering. Dark/light, keyboard-first runner, basic library.

**Phase 2 — Engine and analytics**
Elo/IRT calibration, adaptive selection, weak-area mode, recommendations, MCP performance tools, analytics dashboard, quiz builder with presets.

**Phase 3 — Breadth**
Matching, ordering, cloze, essay with rubrics, code (CodeMirror + worker test runner), hotspot images, image upload, timed and exam-simulation modes with a review screen.

**Phase 4 — Polish**
FSRS weight optimization, command palette, import (Anki .apkg, CSV, Markdown), export/backup, offline PWA, performance pass (≤50ms interactions, virtualized lists).

---

## 10. Repo layout

```
apps/web        Vite React UI
apps/server     Hono API + static serving + MCP HTTP
packages/core   schema, tag pipeline, dedup, graders, FSRS/IRT engine (pure, tested)
packages/mcp    MCP tool definitions (used by stdio bin and HTTP)
packages/types  question type modules (schema + grader shared; renderers in web)
data/           socrates.db, media/
```

---

## 11. Gaps filled (decisions the sections above did not cover)

**Content lifecycle**
- **Drafts:** questions the agent adds start as `draft` by default (configurable). They go to a quick review queue: `A` approves, `E` edits, `X` rejects. Approving one activates it and creates its review-schedule entry.
- **Versioning:** an edit creates a new `question_versions` row. Small fixes (typos) keep the review history; substantive edits (the answer or options change) reset that question's schedule and calibrated difficulty. The agent states which kind it is (`edit_kind: minor|major`).
- **Flag while studying:** `!` in the runner marks a question as wrong or ambiguous. Flagged questions are hidden from sessions and listed in `get_flagged_questions` for the agent to fix.
- **Leeches:** a question with 6 or more lapses is auto-suspended and surfaced with a suggestion to rewrite it or split it into smaller questions (via MCP).
- **Related questions:** questions created together from the same source share a `group_id`. A session never shows two from the same group back to back.

**Scheduling details**
- **Day rollover:** the study day starts at 4 a.m. local time, and streaks and due counts use it. A streak means at least one review session that day; one missed day per week can be covered by a freeze.
- **Daily limits:** caps on new questions and reviews per day so a big bulk import doesn't flood the review queue.
- **Partial credit → FSRS rating:** score < 0.5 is Again, 0.5–0.8 is Hard, > 0.8 goes through the speed and confidence rules.
- **Pending grades:** an agent-graded answer keeps its review-schedule entry unchanged until the grade arrives. I can self-grade instead, and I can override any grade with `O`.
- **Undo:** `Z` undoes the last answer and restores the previous schedule state.

**MCP robustness**
- **Idempotency:** `add_questions` items can carry a `client_ref`. A retry with the same ref returns the existing question and doesn't create a duplicate.
- **Bulk limits:** up to 100 items per call, and each item reports its own result, so one bad item doesn't fail the batch.
- **Validation:** every type's zod schema is published in the tool description. Error messages are written so the agent can fix and retry.
- **HTTP security:** the HTTP endpoint is still exposed to the internet through the tunnel even though there's one user, so it requires a bearer token generated on first run. Stdio needs nothing.
- **Audit log:** every MCP write is recorded (tool, args, result), with a "Recent agent activity" view and one-click revert.

**Media**
- Images are stored in `data/media/` and named by content hash, so the same image is stored once. The MCP tool accepts a URL or base64 data. Paste or drag an image into the editor.

**Data safety**
- An automatic daily SQLite backup keeps the last 14 days. A full export to JSON + media zip and an import of the same.
- Schema migrations are versioned and run on startup after a backup.

**Performance budgets**
- Next question < 50 ms (the next 3 are prefetched), library filter < 100 ms with 50k questions, cold start < 2 s.
- The embedding model loads lazily in a worker and is only used for duplicate checks. Similarity search over ~50k questions is a brute-force scan in memory, which is fast enough at this size, so no vector database is needed.

**Quality**
- `packages/core` gets unit tests for tag normalization and matching, duplicate checks, graders, and the FSRS/difficulty updates. These are the parts where silent bugs would corrupt data.
- An MCP integration test drives the real server through the SDK client.
- Seed script with a small sample question bank, so the UI can be used on day one.

**Phase changes:** drafts, versioning, idempotency, the HTTP token, the audit log and backups move into **Phase 1**. Leech handling and undo go into Phase 2. Import/export stays in Phase 4.

---

## 12. Phase 1 as built (2026-11-11)

Done: schema + migrations, tag pipeline (normalize, plural variants, alias, fuzzy, acronym, reorder, cross-parent leaf check, merge/move/rename with aliases), question dedup, MCP (stdio + stateless HTTP, 21 tools, 2 prompts, audit + revert), 7 question types, SRS and practice modes, attempt tracking, drafts, versioning, backups, keyboard-first UI (home, runner, library, editor, drafts, grading, tags, agent activity, settings).

Deviations from §2, chosen for a simpler Windows setup:
- **`node:sqlite`** (built into Node 22.5+) instead of `better-sqlite3` + Drizzle: no native build step. Raw SQL with versioned migrations.
- **npm** instead of pnpm, and **one package** (`src/` + `web/`) instead of a monorepo. The server runs TypeScript directly via Node's type stripping, so it has no build step.
- **marked + highlight.js** instead of markdown-it + Shiki (synchronous, smaller). Raw HTML in question content is escaped, since agents write it.
- **wouter** instead of TanStack Router.
- **Question similarity is lexical** (word/bigram/char-trigram cosine with an FTS5 prefilter), not embeddings. It catches rewordings and reorderings but not paraphrases with different words ("has an inverse" vs "is invertible"). **Local embeddings move to Phase 2.**
- ChatGPT auth: the token can go in the URL path (`/mcp/t/<token>`) because ChatGPT connectors don't support a static bearer header. The app API refuses non-localhost Host headers, so a tunnel exposes only MCP.

---

## 13. Phase 2 as built (2026-11-11)

Done: Elo/IRT calibration (`src/core/engine.ts`: per-tag ability with half-weight ancestors, per-question difficulty, shrinking step sizes), adaptive and weak-area modes (weighted mix of overdue-ness, weakness, closeness to 80% predicted success and novelty, under the daily new limit), recommendations ("Study next", also exposed as `get_recommendations`), leech flagging, undo, quiz presets, the analytics dashboard, and meaning-based duplicate checks with local embeddings.

Recorded per attempt now: FSRS recall probability when shown, days since last review, the engine's predicted P(correct), and the engine state before the update (for undo).

Findings that changed the design:
- **Embeddings can't tell a statement from its converse.** MiniLM scores "every square matrix is invertible" vs "every invertible matrix is square" at 0.93, higher than a true paraphrase (0.87). So meaning matches only *flag* a possible duplicate, and only when the answers agree. Wording matches still reject.
- **Weak mode picks leaf tags under 65% mastery** (parents only average their children), falling back to the single weakest tag.

Not done (moved to later phases): FSRS weight optimization from your own history (Phase 4), per-question difficulty shown in the editor.
