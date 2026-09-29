# Clip Brain

Before starting any work, read `docs/status/HANDOFF.md`. It covers the current state, real-data results, open items in priority order, and environment notes.

The full build history and every decision made so far are in `docs/status/sdd-ledger.md`. Design spec and plans: `docs/superpowers/`.

- Tests: `npx vitest run` (no external tools needed); typecheck: `npx tsc --noEmit`.
- The full pipeline needs ffmpeg, the `bin/` tools (`npx tsx src/cli.ts setup`), a logged-in `claude` CLI, and YouTube network access. See HANDOFF.md.
- `data/`, `bin/`, `.env` and `.secrets/` are gitignored. Never commit media, credentials or tokens.
- Publishing is dry-run unless `--live`. Never run `publish --live` without the user's explicit go-ahead.
