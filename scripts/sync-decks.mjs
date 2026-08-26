// クイズ.xlsx から decks/ を作り直し、差分を確かめてから push する。
//
//   npm run decks:sync              生成 → 検証 → 差分表示 → commit・push
//   npm run decks:sync -- --dry-run 生成 → 検証 → 差分表示まで（commit しない）
//   npm run decks:sync -- --allow-removals  カード id が消えていても続行する
//
// 手で `import-quiz-xlsx.py` を叩くと、差分を見ないまま push できてしまう。
// **カード id が消えると、その学習進捗は孤児になって復旧できない**ため、
// 削除が1件でもあれば既定で止めて一覧を出す。
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const decksDir = join(root, "decks");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowRemovals = args.includes("--allow-removals");

/** 子プロセスを走らせ、失敗したらそこで止める（出力はそのまま流す） */
function run(command, commandArgs, { capture = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    // デッキ1ファイルで最大2.6MB ある。既定の 1MB では git show が ENOBUFS で落ちる
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) fail(`${command} を実行できません: ${result.error.message}`);
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${commandArgs.join(" ")} が失敗しました（終了コード ${result.status}）`);
  }
  return capture ? result.stdout : "";
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** decks/*.json を読み、デッキ id → (カード id → カード) にする */
async function readDecksFromDisk() {
  const files = (await readdir(decksDir)).filter((name) => name.endsWith(".json"));
  const decks = new Map();
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(decksDir, file), "utf8"));
    decks.set(basename(file, ".json"), indexCards(parsed));
  }
  return decks;
}

/** HEAD 時点の decks/*.json を同じ形で読む（作業ツリーではなくコミット済みの内容） */
function readDecksFromHead() {
  const listing = run("git", ["ls-tree", "--name-only", "HEAD", "decks/"], { capture: true });
  const decks = new Map();
  for (const path of listing.split("\n").filter((line) => line.endsWith(".json"))) {
    const raw = run("git", ["show", `HEAD:${path}`], { capture: true });
    decks.set(basename(path, ".json"), indexCards(JSON.parse(raw)));
  }
  return decks;
}

function indexCards(deck) {
  return new Map((deck.cards ?? []).map((card) => [card.id, card]));
}

/** 同じ id のカードで front/back/note/tags のいずれかが変わったか */
function cardChanged(before, after) {
  const shape = (card) => JSON.stringify([card.front, card.back, card.note ?? "", (card.tags ?? []).join("")]);
  return shape(before) !== shape(after);
}

function diffDecks(before, after) {
  const rows = [];
  const removals = [];
  for (const deckId of new Set([...before.keys(), ...after.keys()]).values()) {
    const oldCards = before.get(deckId) ?? new Map();
    const newCards = after.get(deckId) ?? new Map();
    const added = [...newCards.keys()].filter((id) => !oldCards.has(id));
    const removed = [...oldCards.keys()].filter((id) => !newCards.has(id));
    const changed = [...newCards.keys()].filter((id) => oldCards.has(id) && cardChanged(oldCards.get(id), newCards.get(id)));
    if (added.length === 0 && removed.length === 0 && changed.length === 0) continue;
    rows.push({ deckId, added: added.length, removed: removed.length, changed: changed.length, total: newCards.size });
    for (const id of removed) removals.push({ deckId, id, front: oldCards.get(id).front });
  }
  return { rows, removals };
}

// ---- ここから実行 ----

// 作業ツリーが汚れていると、生成した差分と混ざって何を push したのか分からなくなる
const dirty = run("git", ["status", "--porcelain", "--", "decks"], { capture: true }).trim();
if (dirty !== "") {
  console.error("decks/ に未コミットの変更があります:\n" + dirty);
  fail("先にコミットするか元へ戻してから実行してください");
}

// 生成する前に、比べる相手（コミット済みの内容）を読んでおく
const head = readDecksFromHead();

console.log("== 1/4 クイズ.xlsx からデッキを生成 ==");
run("python3", [join("scripts", "import-quiz-xlsx.py"), ...args.filter((arg) => !arg.startsWith("--"))]);

console.log("\n== 2/4 デッキを検証 ==");
run("node", [join("scripts", "validate-decks.mjs")]);

console.log("\n== 3/4 HEAD との差分 ==");
const { rows, removals } = diffDecks(head, await readDecksFromDisk());

if (rows.length === 0) {
  console.log("変更はありません。");
  process.exit(0);
}

console.log("デッキ".padEnd(20) + "追加".padStart(8) + "削除".padStart(8) + "変更".padStart(8) + "合計".padStart(10));
for (const row of rows) {
  console.log(
    row.deckId.padEnd(20) +
      String(row.added).padStart(8) +
      String(row.removed).padStart(8) +
      String(row.changed).padStart(8) +
      String(row.total).padStart(10),
  );
}

if (removals.length > 0) {
  console.error(`\n✗ カード id が ${removals.length} 件消えています。その学習進捗は孤児になります。`);
  for (const removal of removals.slice(0, 20)) {
    console.error(`   ${removal.deckId} / ${removal.id}: ${removal.front.slice(0, 40)}`);
  }
  if (removals.length > 20) console.error(`   … ほか ${removals.length - 20} 件`);
  if (!allowRemovals) {
    console.error("\nExcel 側で行を消した・Q列「No」を書き換えたのが原因のことが多いです。");
    console.error("意図した削除なら --allow-removals を付けて再実行してください。");
    console.error("元へ戻すには: git checkout -- decks");
    process.exit(1);
  }
  console.error("--allow-removals が指定されているため続行します。");
}

if (dryRun) {
  console.log("\n== 4/4 --dry-run のため commit しません ==");
  console.log("元へ戻すには: git checkout -- decks");
  process.exit(0);
}

console.log("\n== 4/4 commit して push ==");
const summary = rows.map((row) => `${row.deckId} +${row.added}/-${row.removed}/~${row.changed}`).join(", ");
run("git", ["add", "--", "decks"]);
run("git", ["commit", "-m", `chore: クイズ.xlsx からデッキを再生成\n\n${summary}`]);
run("git", ["push"]);
console.log("\n✓ push しました。GitHub Pages へ反映されると、アプリ側は次回起動時に差分だけ取得します。");
