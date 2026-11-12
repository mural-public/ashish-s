import { config } from "../src/config";
import { getMuralClient } from "../src/lib/mural-client";
import { prisma } from "../src/lib/db";

async function main() {
  let pass = true;

  console.log("→ Environment");
  console.log(`  MURAL_API_BASE_URL      = ${config.MURAL_API_BASE_URL}`);
  console.log(`  MURAL_ORG_ID            = ${config.MURAL_ORG_ID}`);
  console.log(`  MURAL_SOURCE_ACCOUNT_ID = ${config.MURAL_SOURCE_ACCOUNT_ID}`);
  console.log(`  MURAL_API_KEY           = ${mask(config.MURAL_API_KEY)}`);
  console.log(`  MURAL_TRANSFER_API_KEY  = ${mask(config.MURAL_TRANSFER_API_KEY)}`);

  console.log("\n→ Database");
  try {
    const count = await prisma.contractor.count();
    console.log(`  ✓ Reachable (${count} contractors seeded)`);
  } catch (e) {
    console.error(`  ✗ Unreachable: ${(e as Error).message}`);
    pass = false;
  }

  console.log("\n→ Mural API");
  try {
    const account = await getMuralClient().getAccount(config.MURAL_SOURCE_ACCOUNT_ID);
    console.log(`  ✓ Source account ${account.id} (${account.name}) — status ${account.status}`);
    const wallet = account.accountDetails?.walletDetails;
    if (wallet) {
      console.log(`    blockchain : ${wallet.blockchain}`);
      console.log(`    wallet     : ${wallet.walletAddress}`);
    }
    const balances = account.accountDetails?.balancesV2;
    if (balances && balances.length > 0) {
      console.log(`    balances   :`);
      for (const b of balances) {
        console.log(`      ${JSON.stringify(b)}`);
      }
    } else {
      console.warn(`    ⚠ No balances found — fund the wallet before running payouts.`);
    }
    if (account.status !== "ACTIVE") {
      console.warn(`  ⚠ Account is not ACTIVE — payouts will fail.`);
    }
  } catch (e) {
    console.error(`  ✗ Mural API unreachable: ${(e as Error).message}`);
    pass = false;
  }

  await prisma.$disconnect();
  if (pass) {
    console.log("\n✓ All checks passed.");
  } else {
    console.log("\n✗ Some checks failed. See errors above.");
  }
  process.exit(pass ? 0 : 1);
}

function mask(s: string): string {
  if (!s) return "(unset)";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
