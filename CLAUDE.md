# CLAUDE.md

## Project
<!-- Fill in during the first minutes: stack, how to run, how to test. -->
- Stack: TypeScript, Express, Postgres
- Run: `docker compose up -d db`, then `npm run dev`
- Test: `npm test` (or `npx vitest run <file>` for one file); typecheck with `npx tsc --noEmit`

## Working preferences
- Before changing code, state a short plan and wait for my go-ahead on anything non-trivial.
- Keep diffs small and focused on the task. Don't refactor unrelated code.
- After every edit, run the typecheck and the relevant tests, and report pass/fail counts.
- After implementing, show me the diff and flag anything you're unsure about.
- Don't add dependencies, commit, or push without asking.
- If something is ambiguous, list the options with a recommendation instead of silently picking one.
- Prefer existing helpers and patterns in the codebase over new abstractions.

## Review lens (backend / payments)
When writing or reviewing code, check:
- Money as decimal strings / NUMERIC, never floats
- Read-then-write races (use conditional updates, row locks, or transactions)
- Explicit state transitions (no double-execute, no executing canceled items)
- Idempotency: claim keys atomically and don't cache failures
- Tenant/org scoping on every query (no IDOR)
- No external calls inside DB transactions
- Webhook signatures verified on the raw body, with a timestamp window and event dedupe
- Ledger consistency (balance change and ledger row commit together)
- Input validation at the boundary
- Pagination: keyset over OFFSET, no N+1 queries
