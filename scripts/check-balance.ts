/**
 * Pre-interview balance check. Confirms the source account has USDC available
 * for the candidate's test payouts. Run before each interview.
 */
import { config } from "../src/config";
import { getMuralClient } from "../src/lib/mural-client";

async function main() {
  const account = await getMuralClient().getAccount(config.MURAL_SOURCE_ACCOUNT_ID);
  console.log(`Account: ${account.id} (${account.name}) — ${account.status}`);

  const balances = account.accountDetails?.balancesV2 ?? [];
  if (balances.length === 0) {
    console.warn("⚠ No balances. Fund the wallet via the Mural sandbox dashboard before the interview.");
    process.exit(1);
  }

  console.log("Balances:");
  for (const b of balances) {
    console.log(`  ${JSON.stringify(b)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
