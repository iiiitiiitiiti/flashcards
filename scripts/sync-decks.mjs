// クイズ.xlsx から decks/ を作り直し、差分を確かめてから push する。
//
//   npm run decks:sync              生成 → 検証 → 差分表示 → commit・push
//   npm run decks:sync -- --dry-run 生成 → 検証 → 差分表示まで（commit しない）
//   npm run decks:sync -- --allow-removals  カード id が消えていても続行する
//   npm run decks:sync -- --on-conflict=xlsx|app  アプリと xlsx の両方が同じカードを変えていたとき、どちらを残すか
//   npm run decks:sync -- --writeback       マージで適用したアプリ側の変更を クイズ.xlsx へ書き戻す（xlwings・Excel が要る）
//
// 手で `import-quiz-xlsx.py` を叩くと、差分を見ないまま push できてしまう。
// **カード id が消えると、その学習進捗は孤児になって復旧できない**ため、
// 削除が1件でもあれば既定で止めて一覧を出す。
//
// アプリ（iPhone）で直した本文・タグ・所属デッキは GitHub の decks/ にだけ入り、xlsx には無い。
// 再生成でそれを消さないよう、前回の再生成コミット（base）→ HEAD（ours）の差分を
// 生成結果（theirs）へ 3-way マージする（`merge-decks.mjs`。docs/decisions/008 参照）。
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAppEdits, mergeDecks } from "./merge-decks.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const decksDir = join(root, "decks");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowRemovals = args.includes("--allow-removals");
const onConflictArg = (args.find((arg) => arg.startsWith("--on-conflict=")) ?? "--on-conflict=stop").slice("--on-conflict=".length);
if (!["stop", "xlsx", "app"].includes(onConflictArg)) fail(`--on-conflict は stop / xlsx / app のいずれか: ${onConflictArg}`);
const writeback = args.includes("--writeback");
/** 再生成コミットの件名。base の特定にも使うので変えない */
const SYNC_COMMIT_SUBJECT = "chore: クイズ.xlsx からデッキを再生成";
/** 大ジャンル名がタグに入る特殊なデッキ。タグを xlsx の列へ戻せないのでマージ対象外 */
const EXCLUDED_FROM_MERGE = ["quiz-sonota"];
/** マージ結果のうち xlsx へ書き戻すべき変更を置く（git 管理外） */
// decks/ の外に置く（中に置くと validate-decks とアプリの一覧取得がデッキとして拾う）
const PENDING_WRITEBACK = join(root, "writeback-pending.json");
// Windows の python3 は Store のスタブ（終了コード 9009）なので python を使う
const PYTHON = process.platform === "win32" ? "python" : "python3";

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

/** コミット時点の decks/*.json をデッキの配列で読む（作業ツリーではなくコミット済みの内容） */
function readDeckFilesAt(revision) {
  const listing = run("git", ["ls-tree", "--name-only", revision, "decks/"], { capture: true });
  const decks = [];
  for (const path of listing.split("\n").filter((line) => line.endsWith(".json"))) {
    const raw = run("git", ["show", `${revision}:${path}`], { capture: true });
    decks.push(JSON.parse(raw));
  }
  return decks;
}

/** HEAD 時点の decks/*.json を デッキ id → (カード id → カード) で読む（差分表示用） */
function readDecksFromHead() {
  return new Map(readDeckFilesAt("HEAD").map((deck) => [deck.id, indexCards(deck)]));
}

/** 前回の再生成コミット。無ければ null（初回、または件名を変えた場合） */
function findLastSyncCommit() {
  const sha = run("git", ["log", "-1", "--format=%H", `--grep=^${SYNC_COMMIT_SUBJECT}`, "--", "decks"], { capture: true }).trim();
  return sha === "" ? null : sha;
}

/** 作業ツリーの decks/*.json をデッキの配列で読む */
async function readDeckFilesFromDisk() {
  const files = (await readdir(decksDir)).filter((name) => name.endsWith(".json"));
  const decks = [];
  for (const file of files) decks.push(JSON.parse(await readFile(join(decksDir, file), "utf8")));
  return decks;
}

/** 生成対象のデッキ id（xlsx 由来）。importer が description に出典を書くので、それで見分ける */
function generatedDeckIds(decks) {
  return decks.filter((deck) => (deck.description ?? "").startsWith("クイズ.xlsx「")).map((deck) => deck.id);
}

function describeEdit(edit) {
  const where = edit.kind === "move" ? `${edit.fromDeck} → ${edit.toDeck}` : edit.toDeck ?? edit.fromDeck;
  const front = (edit.ours ?? edit.base)?.front ?? "";
  return `${edit.kind.padEnd(6)} ${where} / ${edit.cardId}: ${front.slice(0, 40)}`;
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

// アプリから GitHub へ直接デッキを書けるようになったので、手元が遅れていることがある。
// 遅れたまま進むと 4/4 の push が非 fast-forward で弾かれる（git が止めるのでデータは壊れないが、
// 3段目まで走ってから分かりにくく失敗する）。先に確かめて冒頭で止める。
const fetched = spawnSync("git", ["fetch", "origin", "main"], { cwd: root, encoding: "utf8", stdio: "inherit" });
if (fetched.status !== 0) {
  console.warn("! origin から取得できませんでした。手元が最新かどうかは確認できていません。");
} else {
  const behind = run("git", ["rev-list", "--count", "HEAD..origin/main"], { capture: true }).trim();
  if (behind !== "0") {
    console.error(`\n✗ 手元が origin/main より ${behind} コミット遅れています。`);
    console.error("アプリからデッキを追加・編集していると起こります。先に取り込んでから実行してください:");
    console.error("   git pull --ff-only");
    process.exit(1);
  }
}

// 生成する前に、比べる相手（コミット済みの内容）を読んでおく
const head = readDecksFromHead();

// アプリ側の変更を拾うため、生成の前に base と ours を読んでおく
const baseCommit = findLastSyncCommit();
const oursDecks = readDeckFilesAt("HEAD");

console.log("== 1/5 クイズ.xlsx からデッキを生成 ==");
run(PYTHON, [join("scripts", "import-quiz-xlsx.py"), ...args.filter((arg) => !arg.startsWith("--"))]);

console.log("\n== 2/5 アプリ側の変更を生成結果へマージ ==");
if (baseCommit === null) {
  console.warn(`! 前回の再生成コミット（件名「${SYNC_COMMIT_SUBJECT}」）が見つかりません。アプリ側の変更は拾えないので、生成結果をそのまま使います。`);
} else {
  const theirsDecks = await readDeckFilesFromDisk();
  const scope = generatedDeckIds(theirsDecks).filter((id) => !EXCLUDED_FROM_MERGE.includes(id));
  const edits = collectAppEdits(readDeckFilesAt(baseCommit), oursDecks, [...scope, ...EXCLUDED_FROM_MERGE]);
  const merged = mergeDecks(theirsDecks, edits, { onConflict: onConflictArg, excludeDecks: EXCLUDED_FROM_MERGE });
  console.log(`base: ${baseCommit.slice(0, 7)}  アプリ側の変更 ${edits.length} 件 → 適用 ${merged.applied.length} / 反映済み ${merged.noop.length} / 衝突 ${merged.conflicts.length} / 対象外 ${merged.unmergeable.length}`);
  for (const edit of merged.applied) console.log(`   適用   ${describeEdit(edit)}`);
  for (const edit of merged.unmergeable) console.log(`   対象外 ${describeEdit(edit)} — ${edit.reason}`);
  if (merged.conflicts.length > 0) {
    console.error(`\n✗ アプリと xlsx の両方が変えたカードが ${merged.conflicts.length} 件あります:`);
    for (const edit of merged.conflicts) {
      console.error(`   ${describeEdit(edit)}`);
      console.error(`      アプリ: ${edit.ours.front.slice(0, 50)} | ${(edit.ours.tags ?? []).join(", ")}`);
      console.error(`      xlsx : ${edit.theirs ? `${edit.theirs.front.slice(0, 50)} | ${(edit.theirs.tags ?? []).join(", ")}` : "（行が無い）"}`);
    }
    if (onConflictArg === "stop") {
      console.error("\nどちらを残すか決めて再実行してください: --on-conflict=xlsx（xlsx を残す・推奨） / --on-conflict=app（アプリ側を通す）");
      console.error("元へ戻すには: git checkout -- decks");
      process.exit(1);
    }
    console.error(`--on-conflict=${onConflictArg} が指定されているため、${onConflictArg === "xlsx" ? "xlsx 側" : "アプリ側"}を残して続行します。`);
  }
  for (const deck of merged.decks) {
    if (!scope.includes(deck.id)) continue;
    await writeFile(join(decksDir, `${deck.id}.json`), `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  }
  // xlsx へ書き戻すべき変更。--writeback で python に渡す。付けなくても次回まで残る（3値判定なので再適用は no-op）
  const pending = [...merged.applied, ...merged.unmergeable.filter((edit) => edit.kind === "add")].map((edit) => ({
    kind: edit.kind,
    cardId: edit.cardId,
    fromDeck: edit.fromDeck,
    toDeck: edit.toDeck,
    base: edit.base,
    ours: edit.ours,
  }));
  await writeFile(PENDING_WRITEBACK, `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  if (pending.length > 0) {
    if (writeback) {
      console.log("\n-- クイズ.xlsx へ書き戻し --");
      run(PYTHON, [join("scripts", "writeback-quiz-xlsx.py"), PENDING_WRITEBACK, ...args.filter((arg) => !arg.startsWith("--")), ...(dryRun ? ["--dry-run"] : [])]);
    } else {
      console.log(`\n! xlsx へ未反映のアプリ側変更が ${pending.length} 件あります（${basename(PENDING_WRITEBACK)}）。--writeback を付けると xlwings で書き戻します。`);
    }
  }
}

console.log("\n== 3/5 デッキを検証 ==");
run("node", [join("scripts", "validate-decks.mjs")]);

console.log("\n== 4/5 HEAD との差分 ==");
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
  console.log("\n== 5/5 --dry-run のため commit しません ==");
  console.log("元へ戻すには: git checkout -- decks");
  process.exit(0);
}

console.log("\n== 5/5 commit して push ==");
const summary = rows.map((row) => `${row.deckId} +${row.added}/-${row.removed}/~${row.changed}`).join(", ");
run("git", ["add", "--", "decks"]);
run("git", ["commit", "-m", `${SYNC_COMMIT_SUBJECT}\n\n${summary}`]);
run("git", ["push"]);
console.log("\n✓ push しました。GitHub Pages へ反映されると、アプリ側は次回起動時に差分だけ取得します。");
