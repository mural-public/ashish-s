/**
 * Helpers for turning Mural API failures into something actionable.
 *
 * Extracted from scripts/reset-org.ts so the formatting and correlation logic
 * can be unit-tested without hitting the API.
 */
import {
  MuralApiError,
  NON_TERMINAL_FIAT_STATUSES,
  type MuralClient,
  type MuralFiatPayoutStatusType,
} from "./mural-client";

type MuralErrorBody = {
  errorInstanceId?: string;
  name?: string;
  message?: string;
  details?: string;
  params?: Record<string, unknown>;
};

export type MuralErrorInfo = {
  id: string;
  status?: number;
  reason: string;
  trace?: string;
};

/**
 * Mural's error bodies carry more than `message`: `name` (the exception class),
 * `errorInstanceId` (the trace ID support needs to look a failure up), and
 * sometimes `details`/`params`. Keep all of it — and the HTTP status, which is
 * the only reliable way to tell "blocked by a live payout" (412) apart from
 * "already archived" (404) or an auth/agreement problem (401/403).
 *
 * Note that Mural does not send an `x-request-id` header on these responses;
 * `errorInstanceId` in the body is the identifier support can trace.
 */
export function describeMuralError(id: string, e: unknown): MuralErrorInfo {
  if (!(e instanceof MuralApiError)) {
    return { id, reason: e instanceof Error ? e.message : String(e) };
  }

  const body = (typeof e.body === "object" && e.body !== null ? e.body : {}) as MuralErrorBody;
  const parts: string[] = [];
  if (body.name) parts.push(body.name);
  if (body.message) parts.push(body.message);
  if (body.details && body.details !== body.message) parts.push(`(${body.details})`);
  if (body.params && Object.keys(body.params).length > 0) {
    parts.push(`params=${JSON.stringify(body.params)}`);
  }
  // Non-JSON body (the client stores the raw text) — don't let it vanish.
  if (parts.length === 0) parts.push(typeof e.body === "string" ? e.body : e.message);

  return {
    id,
    status: e.status,
    reason: parts.join(": "),
    trace: body.errorInstanceId ?? e.requestId,
  };
}

export type BlockingPayoutLeg = {
  payoutId: string;
  payoutRequestId: string;
  payoutRequestStatus: string;
  rail?: string;
  fiatStatus: MuralFiatPayoutStatusType;
  /**
   * True when the leg can still be released with POST /api/payouts/payout/{id}/cancel.
   * Once the request reaches EXECUTED the fiat leg is with the payment provider and
   * cancel is rejected — only the internal admin tool can mark it failed.
   */
  cancelable: boolean;
};

/**
 * Builds counterpartyId → the payout legs still holding that counterparty's bank
 * account "active". While any such leg exists, archiving the counterparty 412s.
 */
export async function findBlockingPayoutLegs(
  mural: MuralClient,
): Promise<Map<string, BlockingPayoutLeg[]>> {
  const byCounterparty = new Map<string, BlockingPayoutLeg[]>();
  let nextId: string | undefined;
  do {
    const page = await mural.searchPayoutRequests({ limit: 100, nextId });
    for (const pr of page.results) {
      for (const p of pr.payouts) {
        const fiatStatus = p.details?.fiatPayoutStatus?.type;
        const counterpartyId = p.recipientInfo?.counterpartyId;
        if (!fiatStatus || !counterpartyId) continue;
        if (!NON_TERMINAL_FIAT_STATUSES.includes(fiatStatus)) continue;

        const legs = byCounterparty.get(counterpartyId) ?? [];
        legs.push({
          payoutId: p.id,
          payoutRequestId: pr.id,
          payoutRequestStatus: pr.status,
          rail: p.details?.fiatAndRailCode,
          fiatStatus,
          cancelable: pr.status === "AWAITING_EXECUTION" || pr.status === "PENDING",
        });
        byCounterparty.set(counterpartyId, legs);
      }
    }
    nextId = page.nextId;
  } while (nextId);
  return byCounterparty;
}
