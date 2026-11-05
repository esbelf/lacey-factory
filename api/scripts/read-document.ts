// Runs the Claude document reader on a local file and prints what it extracts.
//   npm run read-document -w api -- <file.pdf|jpg|png> [supplier name]
import { config } from "dotenv";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

import { readFile } from "node:fs/promises";
import path from "node:path";

import { claudeConfig } from "../src/config";
import { ClaudeDocumentReader } from "../src/temporal/extract";

const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

const [file, supplierName = "Unknown supplier"] = process.argv.slice(2);
if (!file) throw new Error("Usage: npm run read-document -w api -- <file> [supplier name]");
const mime = TYPES[path.extname(file).toLowerCase()];
if (!mime) throw new Error("Only PDF, JPG and PNG files.");
const out = await new ClaudeDocumentReader(claudeConfig().model).read(await readFile(file), mime, { supplierName });
console.log(JSON.stringify(out, null, 2));
