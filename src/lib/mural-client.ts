import { logger } from "./logger";

// ============================================================================
// Types — minimal subset of Mural's API surface used by this app.
// Full reference: https://developers.muralpay.com/openapi/open-api-spec.json
// ============================================================================

// What Mural's create-counterparty endpoint expects on input.
// Note: response shapes use { state, zip } — different field names. See README.
export type MuralPhysicalAddressInput = {
  address1: string;
  address2?: string;
  country: string;
  subDivision: string;
  city: string;
  postalCode: string;
};

export type MuralIndividualCounterpartyInput = {
  counterparty: {
    type: "individual";
    firstName: string;
    lastName: string;
    email: string;
    physicalAddress: MuralPhysicalAddressInput;
  };
};

export type MuralCounterparty = {
  type: "individual" | "business";
  id: string;
  createdAt: string;
  updatedAt: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  physicalAddress?: Record<string, unknown>;
};

// Per-currency payout method shapes. Extend as you support more rails.
export type MuralPayoutMethodInput =
  | {
      alias?: string;
      payoutMethod: {
        type: "mxn";
        details: {
          type: "mxnDomestic";
          symbol: "MXN";
          bankAccountNumber: string;
          bankId: string;
        };
      };
    }
  | {
      alias?: string;
      payoutMethod: {
        type: "cop";
        details: {
          type: "copDomestic";
          symbol: "COP";
          phoneNumber: string;
          accountType: "CHECKING" | "SAVINGS";
          bankAccountNumber: string;
          documentNumber: string;
          documentType: "NATIONAL_ID" | "RUC_NIT" | "PASSPORT" | "RESIDENT_ID";
          bankId: string;
        };
      };
    };

export type MuralPayoutMethod = {
  id: string;
  alias?: string;
  payoutMethod: { type: string; details: Record<string, unknown> };
};

export type MuralPayoutRequestStatus =
  | "AWAITING_EXECUTION"
  | "PENDING"
  | "EXECUTED"
  | "FAILED"
  | "CANCELED";

export type MuralCreatePayoutRequestInput = {
  sourceAccountId: string;
  memo?: string;
  payouts: Array<{
    amount: { tokenAmount: number; tokenSymbol: "USDC" };
    payoutDetails: {
      type: "counterpartyPayoutMethod";
      payoutMethodId: string;
    };
    recipientInfo: {
      type: "counterpartyInfo";
      counterpartyId: string;
    };
  }>;
};

// Per-recipient fiat status. Lifecycle: created → pending → on-hold? → completed.
// On failure: refundInProgress → refunded. `canceled` happens pre-initiation, and
// `failed` is deprecated in favor of the refund flow. Only the terminal ones
// release the recipient's bank account for archival — see NON_TERMINAL_FIAT_STATUSES.
export type MuralFiatPayoutStatusType =
  | "created"
  | "pending"
  | "on-hold"
  | "completed"
  | "failed"
  | "canceled"
  | "refundInProgress"
  | "refunded";

/**
 * Fiat statuses that keep a payout "active" from Mural's perspective. While any
 * payout for a counterparty is in one of these, archiving that counterparty
 * fails with 412 ("Bank account cannot be deleted...").
 */
export const NON_TERMINAL_FIAT_STATUSES: readonly MuralFiatPayoutStatusType[] = [
  "created",
  "pending",
  "on-hold",
  "refundInProgress",
];

export type MuralPayoutRequest = {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceAccountId: string;
  status: MuralPayoutRequestStatus;
  memo?: string;
  transactionHash?: string;
  payouts: Array<{
    id: string;
    createdAt: string;
    updatedAt: string;
    amount: { tokenAmount: number; tokenSymbol: string };
    // Absent for blockchain payouts, which have `type: "blockchain"` instead.
    details?: {
      type: "fiat" | "blockchain";
      fiatAndRailCode?: string;
      fiatPayoutStatus?: { type: MuralFiatPayoutStatusType };
    };
    recipientInfo?: {
      type: "counterparty" | "inline";
      counterpartyId?: string;
      payoutMethodId?: string;
    };
  }>;
};

export type MuralAccount = {
  id: string;
  name: string;
  status: "INITIALIZING" | "ACTIVE";
  isApiEnabled: boolean;
  accountDetails?: {
    walletDetails: { blockchain: string; walletAddress: string };
    balancesV2: Array<Record<string, unknown>>;
  };
};

export type MuralWebhook = {
  id: string;
  url: string;
  status: "ACTIVE" | "DISABLED";
  eventCategories?: string[];
};

// ============================================================================
// Error
// ============================================================================

export class MuralApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly path: string,
    public readonly requestId?: string,
  ) {
    super(`Mural API ${status} on ${path}`);
    this.name = "MuralApiError";
  }
}

// ============================================================================
// Client
// ============================================================================

type RequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
  useTransferKey?: boolean;
};

export class MuralClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly transferApiKey: string,
    private readonly onBehalfOfOrgId?: string,
  ) {}

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.onBehalfOfOrgId) headers["on-behalf-of"] = this.onBehalfOfOrgId;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    if (options.useTransferKey) headers["transfer-api-key"] = this.transferApiKey;

    logger.debug("mural.request", { method, path });

    const res = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? undefined;
      logger.warn("mural.error", { method, path, status: res.status, requestId });
      throw new MuralApiError(res.status, parsed, path, requestId);
    }

    return parsed as T;
  }

  // ---- Accounts ----
  async getAccount(accountId: string): Promise<MuralAccount> {
    return this.request<MuralAccount>("GET", `/api/accounts/${accountId}`);
  }

  // ---- Counterparties ----
  async createCounterparty(input: MuralIndividualCounterpartyInput): Promise<MuralCounterparty> {
    return this.request<MuralCounterparty>("POST", `/api/counterparties`, { body: input });
  }

  async archiveCounterparty(id: string): Promise<void> {
    await this.request<unknown>("POST", `/api/counterparties/counterparty/${id}/archive`);
  }

  async searchCounterparties(
    opts: { limit?: number; nextId?: string } = {},
    // Note: the response has no `archived` field — this endpoint already
    // excludes archived counterparties, so every result still needs archiving.
  ): Promise<{ results: Array<{ id: string; email?: string }>; nextId?: string }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.nextId) params.set("nextId", opts.nextId);
    const qs = params.toString();
    return this.request("POST", `/api/counterparties/search${qs ? `?${qs}` : ""}`);
  }

  async createPayoutMethod(
    counterpartyId: string,
    input: MuralPayoutMethodInput,
  ): Promise<MuralPayoutMethod> {
    return this.request<MuralPayoutMethod>(
      "POST",
      `/api/counterparties/${counterpartyId}/payout-methods`,
      { body: input },
    );
  }

  // ---- Payout Requests ----
  async createPayoutRequest(
    input: MuralCreatePayoutRequestInput,
    opts: { idempotencyKey?: string } = {},
  ): Promise<MuralPayoutRequest> {
    return this.request<MuralPayoutRequest>("POST", `/api/payouts/payout`, {
      body: input,
      idempotencyKey: opts.idempotencyKey,
    });
  }

  async executePayoutRequest(
    payoutRequestId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<MuralPayoutRequest> {
    return this.request<MuralPayoutRequest>(
      "POST",
      `/api/payouts/payout/${payoutRequestId}/execute`,
      {
        body: { exchangeRateToleranceMode: "FLEXIBLE" },
        idempotencyKey: opts.idempotencyKey,
        useTransferKey: true,
      },
    );
  }

  async getPayoutRequest(payoutRequestId: string): Promise<MuralPayoutRequest> {
    return this.request<MuralPayoutRequest>("GET", `/api/payouts/payout/${payoutRequestId}`);
  }

  async searchPayoutRequests(
    opts: { statuses?: MuralPayoutRequestStatus[]; limit?: number; nextId?: string } = {},
  ): Promise<{ results: MuralPayoutRequest[]; nextId?: string; total: number }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.nextId) params.set("nextId", opts.nextId);
    const qs = params.toString();
    const body = opts.statuses
      ? { filter: { type: "payoutStatus", statuses: opts.statuses } }
      : {};
    return this.request("POST", `/api/payouts/search${qs ? `?${qs}` : ""}`, { body });
  }

  async cancelPayoutRequest(
    payoutRequestId: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<MuralPayoutRequest> {
    return this.request<MuralPayoutRequest>(
      "POST",
      `/api/payouts/payout/${payoutRequestId}/cancel`,
      {
        idempotencyKey: opts.idempotencyKey,
        useTransferKey: true,
      },
    );
  }

  // ---- Webhooks ----
  async listWebhooks(): Promise<MuralWebhook[]> {
    return this.request<MuralWebhook[]>("GET", `/api/webhooks`);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/webhooks/${webhookId}`);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _client: MuralClient | null = null;

export function getMuralClient(): MuralClient {
  if (_client) return _client;
  // Lazy import to avoid loading config in test contexts that mock the client.
  const { config } = require("../config") as typeof import("../config");
  _client = new MuralClient(
    config.MURAL_API_BASE_URL,
    config.MURAL_API_KEY,
    config.MURAL_TRANSFER_API_KEY,
    config.MURAL_ON_BEHALF_OF_ORG_ID,
  );
  return _client;
}
