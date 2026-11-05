// Local dev (GMAIL_MODE=fake): "deliver" an email to eric@lakemat.com and wake
// the mailbox workflow, as a Gmail notification would.
//
//   npm run simulate -w api -- hanes                 # Hanes packing list (photo)
//   npm run simulate -w api -- not-a-supplier        # ignored
//   npm run simulate -w api -- --file ~/invoice.pdf --from billing@hanesgeo.com
//
// In docker compose: docker compose exec api npm run simulate -- hanes
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { emailConfig, MAILBOX_EMAIL } from "../src/config";
import { getDb } from "../src/db";
import { matchSupplier } from "../src/domain/invoices";
import { getAccount } from "../src/email/account";
import { senderAddress } from "../src/email/gmail";
import type { FakeEmail } from "../src/email/mail-source";
import { notifyMailbox } from "../src/temporal/client";

const SCENARIOS: Record<string, { from: string; subject: string; file?: string }> = {
  hanes: {
    from: "Hanes Geo Components <orders@hanesgeo.com>",
    subject: "Packing list 084-51752",
    file: "hanes-packing-list.jpg",
  },
  "not-a-supplier": { from: "Newsletter <news@example.com>", subject: "This week's deals" },
};

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const c = emailConfig();
  if (c.gmailMode !== "fake") throw new Error("simulate only works with GMAIL_MODE=fake.");

  const name = process.argv.slice(2).find((a) => !a.startsWith("--") && !process.argv[process.argv.indexOf(a) - 1]?.startsWith("--"));
  const file = arg("file");
  const scenario = file
    ? { from: arg("from") ?? SCENARIOS.hanes.from, subject: arg("subject") ?? path.basename(file), file: undefined }
    : SCENARIOS[name ?? "hanes"];
  if (!scenario) throw new Error(`Unknown scenario "${name}". Try: ${Object.keys(SCENARIOS).join(", ")}, or --file <path>.`);

  const db = getDb();
  const account = await getAccount(db);
  if (account?.status !== "connected") {
    throw new Error(`${MAILBOX_EMAIL} isn't connected. Sign in as the admin and click "Connect Email" first.`);
  }
  if (!(await matchSupplier(db, senderAddress(scenario.from)))) {
    console.warn(
      `No supplier matches ${senderAddress(scenario.from)}, so this email will be ignored. ` +
        `Add "@${senderAddress(scenario.from).split("@")[1]}" under Settings → Suppliers.`,
    );
  }

  // Attachments are referenced relative to FIXTURES_DIR; uploads are copied in.
  const attachments: FakeEmail["attachments"] = [];
  if (file) {
    const dest = path.join("uploads", `${Date.now()}-${path.basename(file)}`);
    await mkdir(path.join(c.fixturesDir, "uploads"), { recursive: true });
    await copyFile(file, path.join(c.fixturesDir, dest));
    attachments.push({ filename: path.basename(file), path: dest });
  } else if (scenario.file) {
    attachments.push({ filename: scenario.file, path: scenario.file });
  }

  const historyId = Date.now();
  const email: FakeEmail = {
    id: `sim-${historyId}`,
    historyId,
    from: scenario.from,
    subject: scenario.subject,
    receivedAt: new Date().toISOString(),
    attachments,
  };
  const dir = path.join(c.fakeInboxDir, MAILBOX_EMAIL);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${email.id}.json`), JSON.stringify(email, null, 2));
  await notifyMailbox({ emailAddress: MAILBOX_EMAIL, historyId: String(historyId) });
  console.log(`Delivered ${email.id} from ${scenario.from}. Watch it in the Temporal UI (http://localhost:8233) and the app's Inbox.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
