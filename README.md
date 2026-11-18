# Socrates

A personal, local-first quiz platform with spaced repetition and an MCP server so Claude or ChatGPT can write questions, grade your answers and target your weak spots.

## Run

Requires Node 22.18+ (Node 24 recommended). No native modules, no build step for the server.

```bash
npm install
npm start          # builds the UI on first run, serves everything at http://localhost:4321
npm run seed       # optional: 18 sample questions, at least one of every type
```

Development (hot reload UI on :5173, API on :4321):

```bash
npm run dev
```

Data lives in `data/socrates.db` (SQLite). Daily backups go to `data/backups/` (14 kept), plus one before every schema upgrade. Settings → *Data* can back up on demand, export your questions as JSON, or download a full copy of the database. To restore, stop Socrates and replace `data/socrates.db` with a backup.

The UI is installable as an app (Chrome/Edge: the install icon in the address bar) and keeps working from cache if the server is briefly down.

## Deploy

`docs/DEPLOY.md` runs Socrates on a k3s server: the UI on your tailnet behind a password + authenticator login, and the MCP endpoint public behind Orbit Identity OAuth. `Dockerfile` and `deploy/` hold the image and manifests. Locally nothing changes: no login, localhost only.

## Works with Slate, Sprawl and Hey Ann

- **Questions from a note or card:** the `generate_from_source` prompt has an agent read a Slate note or Sprawl card, write questions of fitting types, check for duplicates, tag them, and link each one back through `source` (`{app, id, url, title}`). The link shows after you answer, and in the editor.
- **Openable links:** MCP results carry `url` for questions, sessions and tags (`question_url` on things that refer to a question), built on the server from `SOCRATES_URL`.
- **Study tasks:** `get_study_tasks` returns due reviews and weak, misconception and fading areas in the shape Hey Ann turns into cards: title, reason, estimate, a one-tap `/study/start?…` link and a stable `source`.
- **Study rewards:** real study earns Hey Ann screen time, computed only from the server's own clocks and grading (`docs/REWARDS.md`). Events wait in an outbox (`GET /api/rewards`) until the Orbit Hub transport exists.

## Import

Library → *Import*, or drop a file on the Import page. You see every question and tag before anything is added.

- **Anki** (`.apkg`, `.colpkg`, old and new export formats): basic and cloze notes, images, formatting and MathJax. Deck names and Anki tags become tags (`A::B` → `A > B`). Re-importing a deck only adds new notes. Audio, image occlusion and review history are not imported.
- **CSV / TSV**: two columns (question, answer) work. A header row can add `tags`, `explanation`, `type` (`flashcard`, `mcq`, `tf`, `numeric`, `written`) and `options` (separated by `|`).
- **Markdown**: questions separated by `---`; `Q:` / `A:` / `E:` (explanation) / `Tags:` lines, or a heading with the answer under it; `- [x]` / `- [ ]` for multiple choice; `{{c1::…}}` for cloze. A block with only `Tags:` sets the tags for the blocks after it.
- **Socrates JSON** (from *Export*): tags with aliases and descriptions, every question type, and images.

Imported tags go through the same rules as an agent's: a tag that looks like one you have (`Calculas`, `Capitols`) maps onto the existing one unless you choose *Create new*. Duplicate questions are skipped.

## Connect an AI agent

Settings → *Connect an AI agent* shows the exact commands with your paths and token.

- **Claude Code:** `claude mcp add socrates -s user -- node --no-warnings "<repo>/src/mcp/stdio.ts"`
- **Claude Desktop:** add the `mcpServers` entry from Settings to `claude_desktop_config.json`.
- **ChatGPT:** needs a public HTTPS URL. Run `cloudflared tunnel --url http://localhost:4321`, then add a connector with the URL `https://<tunnel>/mcp/t/<token>`. Only the MCP endpoint is reachable through the tunnel; the app API refuses non-localhost hosts.
- **Other HTTP clients:** `POST http://localhost:4321/mcp` with `Authorization: Bearer <token>`.

### Tools

| Group | Tools |
|---|---|
| Tags | `get_tag_tree`, `resolve_tags`, `create_tags`, `add_tag_alias`, `merge_tags`, `move_tag` |
| Questions | `add_questions` (bulk, `dry_run`, `client_ref`), `check_duplicates`, `update_question`, `set_question_status`, `search_questions`, `get_questions`, `upload_image` |
| Grading | `list_pending_grades`, `submit_grades` |
| Performance | `get_performance_summary`, `get_weak_areas` (calibrated mastery), `get_recommendations`, `get_study_tasks`, `get_recent_mistakes`, `get_coverage_gaps` |
| Sessions | `create_quiz` |
| Prompts | `generate_from_source`, `generate_targeted_questions`, `grade_pending` |

### Tagging rules (enforced by the server)

- Names are normalized: case, plurals, diacritics, `&`/`and`, `C++`/`cpp`. `Integrals`, `integral` and `INTEGRALS` are one tag.
- `add_questions` never creates tags. Unknown tags come back as `unresolved_tags` with the closest existing tags.
- `create_tags` refuses anything that looks like an existing tag (typo, acronym, reordered words, plural variant, alias, same leaf under another parent) unless `force: true` with a `justification`.
- Merges and renames leave the old name as an alias, so it keeps resolving.
- Questions: exact duplicates and anything ≥ 0.92 similar in wording are rejected; 0.85–0.92 is accepted and flagged as a near duplicate.
- Questions that *mean* the same thing (local embeddings, ≥ 0.85) are flagged, never rejected, and only when the answers agree too. Embeddings rate a statement and its converse ("every square matrix is invertible" / "every invertible matrix is square") as close as a true paraphrase, so the answer check is what separates them. The model (all-MiniLM-L6-v2, ~23 MB) downloads into `data/models/` on first use; offline, checks fall back to wording only.

## Question types

Multiple choice (single and multiple answer), true/false, fill in the blank, cloze (`{{c1::answer}}`), numeric (tolerance, units), matching (with distractors), ordering (partial credit by pairwise order), written answer and essay (rubric, graded by you or your agent), code, image hotspot, and flashcards. Prompts take markdown, LaTeX, code blocks and images; paste or drop an image into the editor to upload it.

**Code:** JavaScript questions with tests are graded automatically. Your code runs in a separate Node process with the permission model on (no file access, child processes or workers), an empty environment, a memory cap and a time limit; hidden tests only report pass or fail. Node before v25 doesn't block network access from that process, so a deployment should block egress (the provided manifests do). Other languages are graded against a reference solution by you or your agent.

**Images** are stored in `data/media/` under their content hash. PNG, JPEG, GIF, WebP and AVIF only: SVG is refused because it can carry scripts. When the agent passes a URL, the server only downloads public https addresses, never private or local ones.

## Engine

- **Scheduling:** FSRS-6. The rating comes from correctness, speed against your usual time, confidence and hints.
- **Schedule fitting:** Settings → *Schedule* fits the FSRS weights to your own reviews (needs 100 reviews spaced a day or more apart; 1,000+ is steadier). It shows prediction error on cards left out of the fit before you apply anything, and applying recomputes every card from its history. *Reset to defaults* undoes it.
- **Calibration:** an Elo/IRT model updates your ability per tag (parents at half weight) and each question's difficulty after every graded answer. "Mastery" is the predicted chance of answering an average-difficulty question in that tag.
- **Modes:** *Spaced review* (due + new), *Adaptive* (mix of due, weak and new, aiming at ~80% predicted success), *Weak areas* (lowest-mastery tags), *Practice* (weighted random), *Exam* (random sample spread across tags, no feedback until you submit, mark questions for review, then a full review screen; blank answers score zero). Any mode can have a time limit. Save any setup as a preset.
- **Leeches:** a question forgotten 6 times (configurable) is flagged and leaves the queue until rewritten.
- **Undo:** `z` reverts the last answer, including schedule and calibration.
- **Analytics:** accuracy over time, tag mastery with 14-day trend, forgetting curve and schedule calibration, speed vs accuracy, confidence calibration, difficulty, type, time of day, hesitation and answer changes.
- Questions from an agent start as **drafts** you approve in the app (toggle in Settings). Every agent write is logged in *Agent activity* and most can be reverted.

## Keyboard

Press `?` anywhere. `Ctrl+K` opens the command palette: pages, actions, study sessions, practice by tag, and question search. The essentials: `Enter` on Home starts your review; in a session `1–9` pick, `Enter` checks/next, `q w e r` confidence, `h` hint, `x` flag, `s` skip, `z` undo, `o` open in library, `Esc` end. Matching: digits assign, ↑/↓ change row. Ordering: ↑/↓ pick, Alt+↑/↓ move. Code: Ctrl+' runs tests, Ctrl+Enter submits. Exam: ←/→ move between questions, `m` marks, Ctrl+Enter submits. `g` then a letter jumps between pages. `\` toggles light/dark.

## Tests

```bash
npm test           # core, MCP, engine, question types, schedule fitting and import tests (node:test)
npm run typecheck
```

## Layout

```
src/core     database, tags, questions, graders, FSRS scheduling, study sessions, stats
src/mcp      MCP tool definitions + stdio entry
src/server   Hono API, MCP over HTTP, static UI
web/         Vite + React UI
tests/       node:test suites
```
