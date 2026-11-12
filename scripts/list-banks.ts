/**
 * Lists supported banks for a given set of payout method types (rails).
 * Useful for discovering valid bank IDs to use in the seed file.
 *
 * Usage:
 *   tsx scripts/list-banks.ts mxnDomestic copDomestic
 *
 * Defaults to MXN + COP if no args are provided.
 */
import { config } from "../src/config";

const RAILS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["mxnDomestic", "copDomestic"];

async function main() {
  const url = `${config.MURAL_API_BASE_URL}/api/counterparties/payment-methods/supported-banks?` +
    RAILS.map((r) => `payoutMethodTypes=${encodeURIComponent(r)}`).join("&");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.MURAL_API_KEY}`,
  };
  if (config.MURAL_ON_BEHALF_OF_ORG_ID) {
    headers["on-behalf-of"] = config.MURAL_ON_BEHALF_OF_ORG_ID;
  }
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = (await res.json()) as Record<string, { type: string; banks?: { id: string; name: string }[] }>;

  for (const rail of RAILS) {
    const entry = data[rail];
    if (!entry) {
      console.log(`\n${rail}: (no data returned)`);
      continue;
    }
    if (entry.type === "required" && entry.banks) {
      console.log(`\n${rail} — bank required. Choose one:`);
      for (const b of entry.banks) {
        console.log(`  ${b.id.padEnd(28)} ${b.name}`);
      }
    } else {
      console.log(`\n${rail}: bank not required (${entry.type})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
