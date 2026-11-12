# ContractorPay

A backend that wraps Mural Pay's Payouts API for B2B contractor disbursement.
A finance ops user manages a list of international contractors and pays them
in their local currency. The backend handles Mural counterparty/payout-method
provisioning, payout creation and execution, and status tracking.

This is a starter codebase. You will be asked to extend it.

---

## Prerequisites

Install these before the interview. `npm run bootstrap` will fail fast with a clear message if any are missing.

| Tool | Version | Why |
|------|---------|-----|
| **Node.js** | ≥ 20 | runtime |
| **Docker Desktop** (or Docker Engine + Compose v2) | recent | runs the local Postgres |
| **Git** | any | clone the repo |
| **bash or zsh** | any | `bootstrap.sh` is a POSIX shell script |
| **An editor + your AI tool** | — | bring whatever you use day-to-day (Cursor, Claude Code, Codex, etc.) |

`curl` and `jq` are used in some examples below; both ship with macOS and most Linux distros.

**Windows:** use WSL2 (Ubuntu). Docker Desktop must be set up to integrate with WSL. Native PowerShell will not run `bootstrap.sh`.

**Preflight (run before the interview to verify):**
```bash
node --version          # >= 20
docker --version
docker info > /dev/null && echo "✓ Docker daemon running"
git --version
```

Also confirm port `3000` (server) and `5432` (Postgres) are free. If you have a local Postgres on 5432, stop it (`brew services stop postgresql` or equivalent) before the interview.

---

## Quick start

```bash
# 1. Initialize env from defaults.
cp .env.example .env

# 2. Append the three credentials your interviewer pastes in chat (run the
#    heredoc block they give you as-is — it appends to .env).
#    Example shape:
cat >> .env <<'EOF'
MURAL_API_KEY=<from interviewer>
MURAL_TRANSFER_API_KEY=<from interviewer>
MURAL_SOURCE_ACCOUNT_ID=<from interviewer>
EOF

# 3. Bootstrap (installs deps, starts Postgres, syncs schema, seeds DB).
npm run bootstrap

# 4. Verify Mural connectivity + balance.
npm run doctor

# 5. Run the server.
npm run dev    # starts on PORT (default 3000)
```

Smoke test (in another terminal):
```bash
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/contractors | jq '.contractors | length'
curl -s http://localhost:3000/account | jq '.account.accountDetails.balancesV2'
```

---

## Stack

- **TypeScript + Node.js** (>= 20)
- **Express** for HTTP
- **Prisma** + **PostgreSQL** for persistence
- **Zod** for runtime validation
- **Vitest** for tests
- **Mural Pay API** (sandbox) — see resources below

---

## Project layout

```
src/
├── server.ts                       # Express bootstrap
├── config.ts                       # Zod-validated env config
├── lib/
│   ├── db.ts                       # Prisma client singleton
│   ├── mural-client.ts             # Typed wrapper around Mural's API
│   ├── errors.ts                   # HttpError, NotFoundError, etc.
│   └── logger.ts                   # Structured JSON logger
├── middleware/
│   └── error-handler.ts            # Maps thrown errors to HTTP responses
├── routes/
│   ├── account.ts                  # GET /account
│   ├── contractors.ts              # CRUD for contractors
│   └── payouts.ts                  # Create / read payouts
└── services/
    ├── counterparty-service.ts     # Maps Contractor -> Mural counterparty
    └── payout-service.ts           # Orchestrates payout creation/execution
prisma/
├── schema.prisma                   # Postgres schema
└── seed.ts                         # 5 sample contractors (MX, CO)
scripts/
├── bootstrap.sh                    # One-command setup
├── doctor.ts                       # Verify env + connectivity
├── check-balance.ts                # Balance sanity check
├── list-banks.ts                   # Print supported Mural bank IDs by rail
└── reset-org.ts                    # Cleanup helper
tests/
├── setup.ts                        # Vitest env setup
└── server.test.ts                  # Example tests (extend as you like)
```

---

## Pre-built endpoints

All endpoints accept and return JSON. Errors are returned as
`{ "error": { "code": string, "message": string, "details"?: unknown } }`.

| Method | Path                | Notes |
|--------|---------------------|-------|
| GET    | `/health`           | Liveness probe |
| GET    | `/account`          | Source Mural account: balance + deposit address |
| GET    | `/contractors`      | List contractors. `?isActive=true\|false` filters |
| GET    | `/contractors/:id`  | Get one contractor |
| POST   | `/contractors`      | Create contractor + provision Mural counterparty + payout method |
| PATCH  | `/contractors/:id`  | Update local fields (does not touch Mural) |
| DELETE | `/contractors/:id`  | Soft-delete locally + archive Mural counterparty |
| POST   | `/payouts`          | Create + execute one payout |
| GET    | `/payouts/:id`      | Read a payout |

### Example: create a payout

```bash
# Pick a contractor first
CONTRACTOR_ID=$(curl -s localhost:3000/contractors | jq -r '.contractors[0].id')

curl -X POST localhost:3000/payouts \
  -H 'content-type: application/json' \
  -d '{ "contractorId": "'"$CONTRACTOR_ID"'", "amountUSDC": "10.00" }'
```

---

## Inspecting the local database

Three options, pick whichever you prefer:

```bash
# 1. Prisma Studio — web UI for browsing/editing rows. Opens at http://localhost:5555.
npm run db:studio

# 2. psql — CLI, useful for ad-hoc SQL.
docker compose exec postgres psql -U postgres -d contractor_pay

# 3. From code — drop into a tsx repl or write a one-off script.
tsx -e 'import { prisma } from "./src/lib/db"; prisma.payout.findMany({ include: { contractor: true } }).then(console.log).then(() => prisma.$disconnect())'
```

Studio is the most ergonomic for browsing.

---

## Resources

- **Mural API reference**: https://developers.muralpay.com/reference/
- **OpenAPI spec**: https://developers.muralpay.com/openapi/open-api-spec.json
- **Sandbox docs**: https://developers.muralpay.com/docs/sandbox-environment
- **AI / LLM resources**: https://developers.muralpay.com/docs/ai-developer-resources
- **MCP server**: pre-configured in `.mcp.json`. To register with Claude Code:
  ```bash
  claude mcp add --transport http mural-production https://developers.muralpay.com/mcp
  ```
  Other AI clients (Cursor, Codex, etc.) can be wired up similarly.

---

## Useful npm scripts

| Script                  | What it does |
|-------------------------|---|
| `npm run bootstrap`     | Preflight (Node, Docker, `.env`) + install + Postgres + Prisma client + schema sync + seed |
| `npm run dev`           | tsx watch — dev server with reload |
| `npm run build`         | Compile to `dist/` |
| `npm run start`         | Run the compiled build |
| `npm run doctor`        | Verify env + DB + Mural connectivity |
| `npm run check-balance` | Print source-account balances |
| `npm run list-banks`    | Print Mural's supported bank IDs by rail (`mxnDomestic`, `copDomestic`, …) |
| `npm run reset-org`     | Archive all counterparties + delete webhooks on the Mural org |
| `npm run db:up`         | Start Postgres only |
| `npm run db:down`       | Stop Postgres |
| `npm run db:studio`     | Prisma Studio web UI at http://localhost:5555 |
| `npm run db:seed`       | (Re-)seed contractors |
| `npm run db:reset`      | Wipe + re-push schema + reseed |
| `npm run prisma:generate` | Regenerate the Prisma client (run after editing `schema.prisma`) |
| `npm test`              | Run Vitest |
| `npm run test:watch`    | Vitest watch mode |
| `npm run typecheck`     | tsc --noEmit |
