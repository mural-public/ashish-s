# ContractorPay: architecture and flow diagrams

These diagrams use Mermaid, which renders on GitHub, in VS Code (with a Mermaid
preview extension) and at https://mermaid.live. They show the code as it is
today, gaps included. Notes marked ⚠️ point to weak spots listed in
`CODEBASE_SUMMARY.md`.

1. [Architecture](#1-architecture)
2. [Create a contractor](#2-create-a-contractor)
3. [Create and execute a payout](#3-create-and-execute-a-payout)
4. [Payout status lifecycle](#4-payout-status-lifecycle)
5. [Delete (deactivate) a contractor](#5-delete-deactivate-a-contractor)
6. [Read the account balance](#6-read-the-account-balance)
7. [Reset the Mural org (ops script)](#7-reset-the-mural-org-ops-script)
8. [Data model](#8-data-model)

---

## 1. Architecture

```mermaid
flowchart LR
    user["Finance ops user<br/>(curl / client)"]

    subgraph app["ContractorPay (Express, src/)"]
        direction TB
        server["server.ts<br/>express.json + routers"]
        subgraph routes["routes/"]
            rAcc["account.ts<br/>GET /account"]
            rCon["contractors.ts<br/>CRUD /contractors"]
            rPay["payouts.ts<br/>POST, GET /payouts"]
        end
        subgraph services["services/"]
            sCp["counterparty-service.ts<br/>provisionMuralCounterparty"]
            sPay["payout-service.ts<br/>createPayout, getPayout"]
        end
        subgraph lib["lib/"]
            mural["mural-client.ts<br/>typed HTTP wrapper"]
            db["db.ts<br/>Prisma client"]
            diag["mural-diagnostics.ts"]
        end
        err["middleware/error-handler.ts<br/>HttpError → status code<br/>MuralApiError → 502"]
        cfg["config.ts<br/>Zod env check"]
    end

    pg[("Postgres<br/>(Docker)<br/>Contractor, Payout")]
    muralApi["Mural Pay staging API<br/>api-staging.muralpay.com"]
    scripts["scripts/<br/>bootstrap, doctor, reset-org,<br/>check-balance, list-banks"]

    user -->|HTTP JSON| server
    server --> routes
    rAcc --> mural
    rCon --> db
    rCon --> sCp
    rCon --> mural
    rPay --> sPay
    sPay --> db
    sPay --> sCp
    sPay --> mural
    sCp --> mural
    routes -.errors.-> err
    db --> pg
    mural -->|"Bearer API key<br/>+ transfer-api-key on execute"| muralApi
    scripts --> mural
    scripts --> diag
    scripts --> db
```

---

## 2. Create a contractor

`POST /contractors` in `src/routes/contractors.ts`.

```mermaid
sequenceDiagram
    autonumber
    actor U as Finance user
    participant R as contractors route
    participant DB as Postgres
    participant CS as counterparty-service
    participant M as Mural API

    U->>R: POST /contractors {name, email, address, bankAccount}
    R->>R: Zod check (MXN or COP bank details)
    alt invalid input
        R-->>U: 400 VALIDATION_ERROR
    end
    R->>DB: findUnique(email)
    alt email already exists
        R-->>U: 409 CONFLICT
    end
    Note over R,DB: ⚠️ check-then-insert race:<br/>a concurrent duplicate hits the unique rule → 500
    R->>DB: INSERT Contractor (no Mural IDs yet)
    R->>CS: provisionMuralCounterparty(contractor)
    CS->>M: POST /api/counterparties
    M-->>CS: counterparty.id
    CS->>M: POST /api/counterparties/{id}/payout-methods
    Note over CS,M: ⚠️ if this fails, the counterparty is orphaned in Mural
    M-->>CS: payoutMethod.id
    CS-->>R: {muralCounterpartyId, muralPayoutMethodId}
    Note over R,M: ⚠️ if Mural fails, the local row stays<br/>with no Mural IDs and the user gets 502
    R->>DB: UPDATE Contractor SET Mural IDs
    R-->>U: 201 {contractor}
```

---

## 3. Create and execute a payout

`POST /payouts` in `src/routes/payouts.ts` and `src/services/payout-service.ts`.

```mermaid
sequenceDiagram
    autonumber
    actor U as Finance user
    participant R as payouts route
    participant PS as payout-service
    participant CS as counterparty-service
    participant DB as Postgres
    participant M as Mural API

    U->>R: POST /payouts {contractorId, amountUSDC, memo?}
    R->>R: Zod check (amountUSDC is any string ⚠️)
    R->>PS: createPayout(input)
    PS->>DB: findUnique(contractorId)
    alt not found
        PS-->>U: 404
    else inactive
        PS-->>U: 400
    end
    opt contractor has no Mural IDs yet
        PS->>CS: provisionMuralCounterparty
        CS->>M: create counterparty + payout method
        PS->>DB: UPDATE Contractor SET Mural IDs
    end
    PS->>DB: INSERT Payout (status PENDING, amount as Decimal)
    PS->>M: POST /api/payouts/payout<br/>tokenAmount = Number(amountUSDC) ⚠️ float
    Note over PS,M: ⚠️ no idempotency key: a retry pays twice
    M-->>PS: payoutRequest.id (AWAITING_EXECUTION)
    PS->>M: POST /api/payouts/payout/{id}/execute<br/>(transfer-api-key header)
    alt Mural succeeds
        M-->>PS: payoutRequest (EXECUTED)
    else Mural fails
        M-->>PS: error
        PS->>PS: error logged and swallowed, returns null ⚠️
    end
    PS->>DB: UPDATE Payout SET status = COMPLETED,<br/>muralPayoutId = id or null ⚠️
    PS-->>R: payout
    R-->>U: 201 {payout}
```

The failure path ends the same way as the success path: the payout is marked
`COMPLETED` with no Mural ID.

---

## 4. Payout status lifecycle

The `PayoutStatus` enum in `prisma/schema.prisma`, compared with what the code
actually does.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> PENDING: row inserted
    PENDING --> COMPLETED: after execute,<br/>even if Mural failed ⚠️

    PENDING --> PROCESSING: (never used)
    PROCESSING --> COMPLETED: (never used)
    PROCESSING --> FAILED: (never used)
    PENDING --> FAILED: (never used)
    PENDING --> CANCELED: (never used)

    COMPLETED --> [*]
    FAILED --> [*]
    CANCELED --> [*]
```

Only `PENDING` → `COMPLETED` is ever written. Mural settles fiat payouts after
execution, but there are no webhooks or polling, so nothing moves a payout to
`PROCESSING`, `FAILED` or `CANCELED`.

---

## 5. Delete (deactivate) a contractor

`DELETE /contractors/:id` in `src/routes/contractors.ts`.

```mermaid
sequenceDiagram
    autonumber
    actor U as Finance user
    participant R as contractors route
    participant DB as Postgres
    participant M as Mural API

    U->>R: DELETE /contractors/:id
    R->>DB: findUnique(id)
    alt not found
        R-->>U: 404
    end
    opt has muralCounterpartyId
        R->>M: POST /api/counterparties/counterparty/{id}/archive
        alt payout still in flight
            M-->>R: 412 Precondition Failed
            R-->>U: 502 MURAL_API_ERROR (nothing changed locally)
        end
    end
    R->>DB: UPDATE Contractor SET isActive = false
    R-->>U: 204
    Note over U,M: ⚠️ PATCH {isActive: true} can later reactivate it<br/>while its Mural counterparty stays archived
```

---

## 6. Read the account balance

`GET /account` in `src/routes/account.ts`. This is where money enters the
system: USDC is deposited to the wallet address returned here.

```mermaid
sequenceDiagram
    actor U as Finance user
    participant R as account route
    participant M as Mural API

    U->>R: GET /account
    R->>M: GET /api/accounts/{MURAL_SOURCE_ACCOUNT_ID}
    M-->>R: account (status, wallet, balancesV2)
    R-->>U: 200 {account}
```

---

## 7. Reset the Mural org (ops script)

`npm run reset-org` (`scripts/reset-org.ts`) clears the shared sandbox between
interviews. It doesn't touch the local database.

```mermaid
flowchart TD
    start([npm run reset-org]) --> wh[List webhooks]
    wh --> whDel[Delete each webhook]
    whDel --> pr["Search payout requests<br/>status = AWAITING_EXECUTION<br/>(paginated)"]
    pr --> prCancel[Cancel each one]
    prCancel --> cp["Search active counterparties<br/>(paginated)"]
    cp --> arch[Archive each counterparty]
    arch --> res{Result}
    res -->|200| ok[archived]
    res -->|404| gone[already archived]
    res -->|412| blocked[blocked]
    res -->|other| fail[unexpected failure]
    blocked --> legs["findBlockingPayoutLegs<br/>(mural-diagnostics.ts)<br/>non-terminal fiat legs<br/>grouped by counterparty"]
    legs --> hint{Request status?}
    hint -->|AWAITING_EXECUTION| canc[cancelable via API]
    hint -->|EXECUTED| admin["needs admin intervention:<br/>mark withdrawal failed"]
    ok --> done([Print summary])
    gone --> done
    canc --> done
    admin --> done
    fail --> done
```

---

## 8. Data model

From `prisma/schema.prisma`.

```mermaid
erDiagram
    Contractor ||--o{ Payout : "receives"
    Contractor {
        uuid id PK
        string firstName
        string lastName
        string email UK
        json physicalAddress
        json bankAccount "mxnDomestic or copDomestic"
        string currency "MXN or COP"
        string muralCounterpartyId UK "nullable"
        string muralPayoutMethodId "nullable"
        boolean isActive
        datetime createdAt
        datetime updatedAt
    }
    Payout {
        uuid id PK
        uuid contractorId FK
        decimal amountUSDC "NUMERIC(18,6)"
        string memo "nullable"
        string muralPayoutId UK "nullable"
        enum status "PENDING, PROCESSING, COMPLETED, FAILED, CANCELED"
        string errorMessage "nullable, never written"
        datetime createdAt
        datetime updatedAt
    }
```
