// アプリ側の編集を、xlsx からの再生成で消さないための 3-way マージ（純関数）。
//
//   base   = 前回の再生成コミット時点の decks/（xlsx とアプリが一致していた最後の状態）
//   ours   = HEAD の decks/（その後アプリが GitHub へ書いた編集を含む）
//   theirs = いま xlsx から生成した decks/
//
// base→ours の差分が「アプリでやったこと」。theirs のそのカードが base のままなら ours を
// 適用し、すでに ours と同じなら何もしない（xlsx へ反映済み）。どちらとも違えば衝突。
// タグは順序を持たない集合として比べる（TagPicker は末尾に足す・importer は決まった順に並べる）。
//
// ここは git も fs も触らない。sync-decks.mjs が読み込みと出力を担当する。

/** デッキ配列 → Map<deckId, Map<cardId, card>> */
export function indexDecks(decks) {
  return new Map(decks.map((deck) => [deck.id, new Map(deck.cards.map((card) => [card.id, card]))]));
}

function normalizeTags(tags) {
  return [...(tags ?? [])].map((tag) => tag.trim()).filter((tag) => tag !== "").sort();
}

/** front/back/note/tags（集合）が同じか。id とデッキは見ない */
export function sameCardContent(left, right) {
  if (!left || !right) return false;
  return (
    left.front === right.front &&
    left.back === right.back &&
    (left.note ?? "") === (right.note ?? "") &&
    JSON.stringify(normalizeTags(left.tags)) === JSON.stringify(normalizeTags(right.tags))
  );
}

/** カード id → 所属デッキ id（重複していれば最初のもの） */
function locateCards(index) {
  const where = new Map();
  for (const [deckId, cards] of index) {
    for (const cardId of cards.keys()) {
      if (!where.has(cardId)) where.set(cardId, deckId);
    }
  }
  return where;
}

/**
 * base→ours の差分を「アプリ側の変更」として分類する。
 * 対象は `deckIds`（xlsx から生成するデッキ）に限り、それ以外のデッキは見ない。
 *
 * 返り値: { kind: "edit"|"move"|"add"|"remove", cardId, fromDeck, toDeck, base, ours }
 */
export function collectAppEdits(baseDecks, oursDecks, deckIds) {
  const scope = new Set(deckIds);
  const base = indexDecks(baseDecks.filter((deck) => scope.has(deck.id)));
  const ours = indexDecks(oursDecks.filter((deck) => scope.has(deck.id)));
  const baseWhere = locateCards(base);
  const oursWhere = locateCards(ours);
  const edits = [];

  for (const [cardId, toDeck] of oursWhere) {
    const oursCard = ours.get(toDeck).get(cardId);
    const fromDeck = baseWhere.get(cardId);
    if (fromDeck === undefined) {
      edits.push({ kind: "add", cardId, fromDeck: null, toDeck, base: null, ours: oursCard });
      continue;
    }
    const baseCard = base.get(fromDeck).get(cardId);
    if (fromDeck !== toDeck) {
      edits.push({ kind: "move", cardId, fromDeck, toDeck, base: baseCard, ours: oursCard });
    } else if (!sameCardContent(baseCard, oursCard)) {
      edits.push({ kind: "edit", cardId, fromDeck, toDeck, base: baseCard, ours: oursCard });
    }
  }
  for (const [cardId, fromDeck] of baseWhere) {
    if (!oursWhere.has(cardId)) {
      edits.push({ kind: "remove", cardId, fromDeck, toDeck: null, base: base.get(fromDeck).get(cardId), ours: null });
    }
  }
  return edits;
}

/**
 * theirs（生成結果）へアプリ側の変更を適用する。theirs は変更せず、新しいデッキ配列を返す。
 *
 * - applied:   theirs へ反映した変更（xlsx へも書き戻すべきもの）
 * - noop:      theirs が既に ours と同じだった変更（xlsx に反映済み）
 * - conflicts: theirs が base とも ours とも違う変更。`onConflict` が "xlsx" なら theirs を残し、
 *              "app" なら ours を強制適用する。"stop"（既定）なら何も適用せず一覧だけ返す
 * - unmergeable: 生成側に行が無い add（ours のデッキへ残す）、remove（アプリに削除は無いので衝突扱い）
 */
export function mergeDecks(theirsDecks, edits, { onConflict = "stop", excludeDecks = [] } = {}) {
  const excluded = new Set(excludeDecks);
  const result = new Map(theirsDecks.map((deck) => [deck.id, { ...deck, cards: [...deck.cards] }]));
  const theirs = indexDecks(theirsDecks);
  const theirsWhere = locateCards(theirs);
  const applied = [];
  const noop = [];
  const conflicts = [];
  const unmergeable = [];

  const removeFrom = (deckId, cardId) => {
    const deck = result.get(deckId);
    if (deck) deck.cards = deck.cards.filter((card) => card.id !== cardId);
  };
  const putInto = (deckId, card) => {
    const deck = result.get(deckId);
    if (!deck) return false;
    const index = deck.cards.findIndex((existing) => existing.id === card.id);
    if (index === -1) deck.cards.push(card);
    else deck.cards[index] = card;
    return true;
  };

  for (const edit of edits) {
    if (excluded.has(edit.fromDeck) || excluded.has(edit.toDeck)) {
      unmergeable.push({ ...edit, reason: "対象外のデッキ（大ジャンル名がタグに入る quiz-sonota など）" });
      continue;
    }
    if (edit.kind === "remove") {
      unmergeable.push({ ...edit, reason: "アプリに削除機能は無いので、想定外の差分として扱う" });
      continue;
    }
    if (edit.kind === "add") {
      if (theirsWhere.has(edit.cardId)) {
        // xlsx に同じ id の行が現れた（No を振った）。生成側を正とする
        noop.push(edit);
      } else if (putInto(edit.toDeck, edit.ours)) {
        unmergeable.push({ ...edit, reason: "xlsx に行が無い。アプリ側のデッキに残す（xlsx へ行を足すまで一覧に出る）" });
      } else {
        unmergeable.push({ ...edit, reason: `移動先デッキ「${edit.toDeck}」が生成結果に無い` });
      }
      continue;
    }
    // edit / move
    const theirsDeck = theirsWhere.get(edit.cardId);
    const theirsCard = theirsDeck === undefined ? null : theirs.get(theirsDeck).get(edit.cardId);
    const alreadyOurs = theirsDeck === edit.toDeck && sameCardContent(theirsCard, edit.ours);
    if (alreadyOurs) {
      noop.push(edit);
      continue;
    }
    const stillBase = theirsDeck === edit.fromDeck && sameCardContent(theirsCard, edit.base);
    if (!stillBase) {
      conflicts.push({ ...edit, theirsDeck, theirs: theirsCard });
      if (onConflict !== "app") continue;
    }
    if (theirsDeck !== undefined) removeFrom(theirsDeck, edit.cardId);
    if (!putInto(edit.toDeck, edit.ours)) {
      unmergeable.push({ ...edit, reason: `移動先デッキ「${edit.toDeck}」が生成結果に無い` });
      continue;
    }
    applied.push(edit);
  }

  return { decks: [...result.values()], applied, noop, conflicts, unmergeable };
}
