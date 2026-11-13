# ContractorPay: codebase summary

ContractorPay is an Express and Postgres backend. A finance user keeps a list of
international contractors and pays them in their local currency, Mexican pesos
(MXN) or Colombian pesos (COP). The money is sent as USDC (a dollar-pegged
stablecoin) through Mural Pay's staging API.

## How it's organized

| Layer | Files | Role |
|---|---|---|
| HTTP | `src/server.ts`, `src/routes/*` | Express app with `/health`, `/account`, `/contractors` and `/payouts` |
| Services | `src/services/counterparty-service.ts`, `payout-service.ts` | Business logic that coordinates the database and Mural |
| Mural client | `src/lib/mural-client.ts` | Typed wrapper around Mural's HTTP API (described below) |
| Persistence | `prisma/schema.prisma` | Two tables: `Contractor` and `Payout` (status: PENDING, PROCESSING, COMPLETED, FAILED or CANCELED) |
| Errors | `src/lib/errors.ts`, `src/middleware/error-handler.ts` | Turns errors into a standard error response; Mural failures come back as 502 with Mural's response body |
| Config | `src/config.ts` | Checks environment variables with Zod at startup and exits if any are invalid |

The Mural client sends the main API key on every call. The transfer API key is
only sent on the call that executes a payout. Idempotency keys are supported,
but nothing passes one yet.

## Main features

### 1. Contractors (`src/routes/contractors.ts`)

- **Create:** checks the name, email, address and bank details. Bank details
  are MXN (account number and bank ID) or COP (also phone and ID document). It
  saves the contractor locally, then creates a Mural **counterparty** (the
  recipient) and a **payout method** (their bank account), and saves those
  Mural IDs on the row.
- **List and get:** `isActive` filters the list.
- **Update:** changes local fields only and doesn't touch Mural.
- **Delete:** archives the counterparty in Mural, then marks the contractor
  inactive locally.

### 2. Payouts (`src/services/payout-service.ts`)

- `POST /payouts` takes a contractor ID and an amount in USDC.
- It sets up the contractor in Mural first if that hasn't happened yet.
- It saves a `PENDING` payout, creates a payout request in Mural, executes it,
  and marks the row `COMPLETED`.
- `GET /payouts/:id` returns the payout with its contractor.

### 3. Account (`src/routes/account.ts`)

- `GET /account` reads the Mural source account's balances and deposit wallet.
  It's read-only.

### 4. Ops scripts (`scripts/`)

- `bootstrap` and `doctor`: setup and connectivity checks.
- `check-balance` and `list-banks`: print balances and the bank IDs Mural
  supports.
- `reset-org`: cleans up the Mural org by archiving all counterparties and
  deleting webhooks. It uses `src/lib/mural-diagnostics.ts` to explain why an
  archive was blocked, usually because a payout is still in flight. That module
  is what `tests/mural-diagnostics.test.ts` covers.

## Weak spots worth knowing

These were checked against the backend and payments review list in
`CLAUDE.md`. This is a starter codebase meant to be extended, so these are
likely where the work will be.

1. **Failed payouts are recorded as successes.** `sendToMural` catches every
   error and returns `null`. The payout is then still marked `COMPLETED`, with
   no Mural ID (`src/services/payout-service.ts:68-87`).
2. **Payouts are marked `COMPLETED` the moment they're executed.** Mural
   settles bank payouts later, and nothing checks their status afterwards.
   There are no webhooks or polling, so `PROCESSING`, `FAILED` and `CANCELED`
   are never used.
3. **The amount is converted to a float.** `Number(input.amountUSDC)` is what
   gets sent to Mural. The amount itself is accepted as any string: zero and
   negative values pass, and a non-number like `"abc"` crashes with a 500.
4. **No idempotency.** A retried request makes a second payout request in Mural
   and pays twice, even though the client already supports idempotency keys.
5. **Contractor creation isn't atomic.**
   - Two requests with the same email can both pass the duplicate check; the
     second hits the database's unique rule and returns a 500 instead of a 409.
   - If setup in Mural fails, the local contractor stays behind with no Mural
     IDs.
   - If the payout method fails after the counterparty was created, the
     counterparty is left orphaned in Mural.
6. **Local data and Mural can drift apart.**
   - Changing a contractor's email doesn't update Mural.
   - `PATCH {isActive: true}` can reactivate a contractor whose Mural
     counterparty was archived.
7. **No authentication, organization scoping or pagination.** There's also no
   endpoint to list payouts.
