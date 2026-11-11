# Socrates

A personal, local-first quiz platform with spaced repetition and an MCP server so Claude or ChatGPT can write questions, grade your answers and target your weak spots.

## Run

Requires Node 22.18+ (Node 24 recommended). No native modules, no build step for the server.

```bash
npm install
npm start          # builds the UI on first run, serves everything at http://localhost:4321
npm run seed       # optional: 12 sample questions
```

Development (hot reload UI on :5173, API on :4321):

```bash
npm run dev
```

Data lives in `data/socrates.db` (SQLite). Daily backups go to `data/backups/` (14 kept), plus one before every schema upgrade.

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
| Questions | `add_questions` (bulk, `dry_run`, `client_ref`), `check_duplicates`, `update_question`, `set_question_status`, `search_questions`, `get_questions` |
| Grading | `list_pending_grades`, `submit_grades` |
| Performance | `get_performance_summary`, `get_weak_areas`, `get_recent_mistakes`, `get_coverage_gaps` |
| Sessions | `create_quiz` |
| Prompts | `generate_targeted_questions`, `grade_pending` |

### Tagging rules (enforced by the server)

- Names are normalized: case, plurals, diacritics, `&`/`and`, `C++`/`cpp`. `Integrals`, `integral` and `INTEGRALS` are one tag.
- `add_questions` never creates tags. Unknown tags come back as `unresolved_tags` with the closest existing tags.
- `create_tags` refuses anything that looks like an existing tag (typo, acronym, reordered words, plural variant, alias, same leaf under another parent) unless `force: true` with a `justification`.
- Merges and renames leave the old name as an alias, so it keeps resolving.
- Questions: exact duplicates and anything ≥ 0.92 similar are rejected; 0.85–0.92 is accepted and flagged as a near duplicate.
- Questions from an agent start as **drafts** you approve in the app (toggle in Settings). Every agent write is logged in *Agent activity* and most can be reverted.

## Keyboard

Press `?` anywhere. The essentials: `Enter` on Home starts your review; in a session `1–9` pick, `Enter` checks/next, `q w e r` confidence, `h` hint, `x` flag, `s` skip, `e` edit, `Esc` end. `g` then a letter jumps between pages. `\` toggles light/dark.

## Tests

```bash
npm test           # core + MCP integration tests (node:test)
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
