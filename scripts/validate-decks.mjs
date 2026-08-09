// decks/*.json を validateDeck で検証する（CI とローカルの共通チェック）
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeck } from "../src/deck.ts";

const decksDir = join(dirname(fileURLToPath(import.meta.url)), "..", "decks");
const files = (await readdir(decksDir)).filter((name) => name.endsWith(".json"));

let failed = false;
for (const file of files) {
  const expectedId = basename(file, ".json");
  try {
    const raw = await readFile(join(decksDir, file), "utf8");
    validateDeck(JSON.parse(raw), expectedId);
    console.log(`OK   decks/${file}`);
  } catch (error) {
    failed = true;
    console.error(`NG   decks/${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (files.length === 0) {
  console.warn("decks/ に JSON がありません");
}
if (failed) process.exit(1);
