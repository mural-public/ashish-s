/**
 * Cleanup script for interviewers. Run between candidate interviews to reset
 * the shared sandbox org's mutable state:
 *   - Deletes all webhooks (next candidate's localhost-tunnel registrations
 *     would otherwise pile up and point at dead URLs).
 *   - Cancels payout requests stuck in AWAITING_EXECUTION (created but never
 *     executed — they hold the counterparty's bank account "active" forever).
 *   - Archives all counterparties (frees the unique-email constraint so the
 *     next candidate's seed re-provisions cleanly — Mural rejects a second
 *     counterparty with the same email while the first is unarchived).
 *
 * Does NOT touch payouts, accounts, or USDC balance — those accumulate
 * harmlessly in the sandbox.
 *
 * On the 412 from archive: it is NOT limited to AWAITING_EXECUTION requests.
 * Any payout leg whose fiat status is non-terminal (`created`, `pending`,
 * `on-hold`, `refundInProgress`) keeps the recipient's bank account active,
 * including legs on requests that already reached EXECUTED — those cannot be
 * canceled through the public API. In the sandbox, MXN legs are not guaranteed
 * to leave `pending`, so such counterparties stay unarchivable until an admin
 * marks the underlying withdrawal requests failed. This script identifies the
 * exact blocking legs and points at that remediation rather than telling you
 * to wait for a settlement that will not come.
 */
import { getMuralClient } from "../src/lib/mural-client";
import {
  describeMuralError,
  findBlockingPayoutLegs,
  type MuralErrorInfo,
} from "../src/lib/mural-diagnostics";
import { config } from "../src/config";

const ADMIN_MARK_FAILED_PATH = "/retool-admin-v2/withdrawal-requests/mark-as-failed";

function printFailures(failures: MuralErrorInfo[]) {
  for (const f of failures) {
    const status = f.status !== undefined ? `HTTP ${f.status} ` : "";
    console.log(`  - ${f.id}: ${status}${f.reason}`);
    if (f.trace) console.log(`      trace: ${f.trace}`);
  }
}

async function main() {
  const mural = getMuralClient();

  // Webhooks ---------------------------------------------------------------
  const webhooks = await mural.listWebhooks();
  if (webhooks.length === 0) {
    console.log("Webhooks: none registered.");
  } else {
    console.log(`Webhooks: deleting ${webhooks.length}...`);
    for (const w of webhooks) {
      console.log(`  - ${w.id} → ${w.url}`);
      await mural.deleteWebhook(w.id);
    }
  }

  // Stuck payout requests ----------------------------------------------------
  // AWAITING_EXECUTION requests never settle on their own; cancel them so the
  // archive step below doesn't 412 on "active withdrawal or deposit requests".
  let canceled = 0;
  const cancelFailed: MuralErrorInfo[] = [];
  let payoutNextId: string | undefined;
  do {
    const page = await mural.searchPayoutRequests({
      statuses: ["AWAITING_EXECUTION"],
      limit: 100,
      nextId: payoutNextId,
    });
    for (const pr of page.results) {
      try {
        await mural.cancelPayoutRequest(pr.id);
        canceled++;
      } catch (e) {
        cancelFailed.push(describeMuralError(pr.id, e));
      }
    }
    payoutNextId = page.nextId;
  } while (payoutNextId);

  if (canceled === 0 && cancelFailed.length === 0) {
    console.log("Payout requests: none awaiting execution.");
  } else {
    console.log(`Payout requests: canceled ${canceled}, ${cancelFailed.length} failed.`);
    printFailures(cancelFailed);
  }

  // Counterparties ---------------------------------------------------------
  // Note: the search endpoint already excludes archived counterparties, so
  // everything returned here needs archiving. A 404 on archive means Mural
  // considers it already gone ("not found or has already been archived").
  let archived = 0;
  let alreadyArchived = 0;
  const blocked: MuralErrorInfo[] = [];
  const failed: MuralErrorInfo[] = [];
  let nextId: string | undefined;
  do {
    const page = await mural.searchCounterparties({ limit: 100, nextId });
    for (const c of page.results) {
      try {
        await mural.archiveCounterparty(c.id);
        archived++;
        if (archived % 10 === 0) console.log(`  ...archived ${archived}`);
      } catch (e) {
        const info = describeMuralError(c.id, e);
        if (info.status === 404) alreadyArchived++;
        else if (info.status === 412) blocked.push(info);
        else failed.push(info);
      }
    }
    nextId = page.nextId;
  } while (nextId);

  console.log(
    `Counterparties: archived ${archived}, ${alreadyArchived} already-archived, ` +
      `${blocked.length} blocked, ${failed.length} failed.`,
  );
  if (blocked.length > 0) {
    console.log("\nBlocked by a payout still holding the bank account (412):");
    const legsByCounterparty = await findBlockingPayoutLegs(mural);
    let anyStuck = false;

    for (const f of blocked) {
      const status = f.status !== undefined ? `HTTP ${f.status} ` : "";
      console.log(`  - ${f.id}: ${status}${f.reason}`);
      if (f.trace) console.log(`      trace: ${f.trace}`);

      const legs = legsByCounterparty.get(f.id) ?? [];
      if (legs.length === 0) {
        console.log("      no non-terminal payout legs found — cause is not a live payout");
        continue;
      }
      for (const l of legs) {
        const rail = l.rail ? `${l.rail} ` : "";
        const hint = l.cancelable ? "cancelable via API" : "needs admin intervention";
        console.log(
          `      payout ${l.payoutId} (${rail}${l.fiatStatus}) ` +
            `on request ${l.payoutRequestId} [${l.payoutRequestStatus}] — ${hint}`,
        );
      }
      if (legs.some((l) => !l.cancelable)) anyStuck = true;
    }

    if (anyStuck) {
      console.log(
        "\n  Legs marked 'needs admin intervention' sit on an already-EXECUTED request,\n" +
          "  so the public cancel endpoint will reject them. In the sandbox some rails\n" +
          "  (MXN in particular) are not guaranteed to leave `pending`, so waiting will\n" +
          "  not clear them. Release the underlying withdrawal requests with the internal\n" +
          "  admin endpoint, then re-run this script:\n" +
          `\n    POST ${config.MURAL_API_BASE_URL}${ADMIN_MARK_FAILED_PATH}\n` +
          "\n  That endpoint is admin-only and is not callable with the API keys in .env,\n" +
          "  so this script does not attempt it.",
      );
    }
  }
  if (failed.length > 0) {
    console.log("\nUnexpected archive failures:");
    printFailures(failed);
  }
  console.log("\nOrg reset complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
