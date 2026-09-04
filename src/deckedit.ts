import type { Deck, DeckCard } from "./deck";

/** 入力欄の1行からタグ配列を作る。区切りは ; , 、のいずれか。空なら undefined */
export function parseTags(value: string): string[] | undefined {
  const tags = value
    .split(/[;,、]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return tags.length > 0 ? tags : undefined;
}

/** カード編集フォームの中身。カード一覧と学習画面で同じ形を使う */
export interface CardForm {
  front: string;
  back: string;
  note: string;
  /** 選んだタグ（`TagPicker`）。空配列ならタグ無し */
  tags: string[];
}

/**
 * フォームの内容からカードを作る。前後の空白は落とし、空の note / tags は**キーごと省く**
 * （デッキ JSON に空文字が残らないようにする）。id は呼び出し側が決める（既存カードは変えない）。
 */
export function buildCard(id: string, form: CardForm): DeckCard {
  const tags = form.tags.map((tag) => tag.trim()).filter((tag) => tag !== "");
  return {
    id,
    front: form.front.trim(),
    back: form.back.trim(),
    ...(form.note.trim() !== "" ? { note: form.note.trim() } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * xlsx から機械生成しているデッキか（`import-quiz-xlsx.py` が description に出典を書く）。
 * こうしたデッキは体系にあるタグしか xlsx へ戻せないので、タグ選択で新規タグを作らせない
 */
export function isGeneratedDeck(deck: Deck): boolean {
  return (deck.description ?? "").startsWith("クイズ.xlsx「");
}

/** 表面と裏面は必須。足りなければ理由を返す（問題なければ null） */
export function validateCardForm(form: CardForm): string | null {
  if (form.front.trim() === "" || form.back.trim() === "") return "表面と裏面は必須です。";
  return null;
}

/** カードを追加または（同 id があれば）置換した新しいデッキを返す */
export function upsertCard(deck: Deck, card: DeckCard): Deck {
  const index = deck.cards.findIndex((existing) => existing.id === card.id);
  const cards = [...deck.cards];
  if (index === -1) {
    cards.push(card);
  } else {
    cards[index] = card;
  }
  return { ...deck, cards };
}

/**
 * 新規カードを末尾へ追加した新しいデッキを返す（CSV インポート用・append-only）。
 * すでに同 id のカードが存在する行は「適用済み」としてスキップする。
 * これにより、PUT 成功後に応答だけ失われた場合の再試行が重複追加にならない。
 */
export function appendCards(deck: Deck, cards: DeckCard[]): { deck: Deck; appended: number; skipped: number } {
  const existingIds = new Set(deck.cards.map((card) => card.id));
  const fresh = cards.filter((card) => !existingIds.has(card.id));
  return {
    deck: fresh.length === 0 ? deck : { ...deck, cards: [...deck.cards, ...fresh] },
    appended: fresh.length,
    skipped: cards.length - fresh.length,
  };
}

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * デッキ内で使われているタグを件数の多い順に返す（同数なら日本語の辞書順）。
 * タグ選択 UI の候補。既存のタグが見えないと、似た綴りのタグが増える。
 */
export function collectDeckTags(deck: Deck): TagCount[] {
  const counts = new Map<string, number>();
  for (const card of deck.cards) {
    for (const tag of card.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, "ja"));
}

/** タグの付け外し。既にあれば外し、無ければ末尾へ足す。元の配列は変更しない */
export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((existing) => existing !== tag) : [...tags, tag];
}

/** 指定 id のカードを除いた新しいデッキを返す（無ければそのまま） */
export function removeCard(deck: Deck, cardId: string): Deck {
  if (!deck.cards.some((card) => card.id === cardId)) return deck;
  return { ...deck, cards: deck.cards.filter((card) => card.id !== cardId) };
}

/** ★☆☆ のような難易度タグか（xlsx の D列に入る） */
export function isDifficultyTag(tag: string): boolean {
  return tag !== "" && [...tag].every((character) => character === "★" || character === "☆");
}

export const SHUTSUDAI_TAG = "出題済み";

/**
 * xlsx から生成するデッキのタグは、xlsx の列へ戻せる形でなければならない:
 * 小ジャンル（★でも「出題済み」でもないタグ）が**ちょうど1つ**、難易度は1つまで。
 * iPhone で保存した時点で止める（次の decks:sync まで気づかないと直しにくい）。問題なければ null
 */
export function validateGeneratedTags(tags: string[]): string | null {
  const subgenres = tags.filter((tag) => !isDifficultyTag(tag) && tag !== SHUTSUDAI_TAG);
  const difficulties = tags.filter((tag) => isDifficultyTag(tag));
  if (subgenres.length !== 1) {
    return subgenres.length === 0
      ? "小ジャンルのタグを1つ選んでください（★と「出題済み」以外のタグ）。"
      : `小ジャンルのタグは1つだけにしてください（いま ${subgenres.length} 個: ${subgenres.join("・")}）。`;
  }
  if (difficulties.length > 1) return "難易度（★）のタグは1つまでです。";
  return null;
}

/**
 * Contents API で書き込めるデッキ JSON の上限。GitHub はこれを超えるファイルの本文を返さないので、
 * 1MB を超えるデッキ（公民・理系・生活）はアプリから書き戻せない。移動先・移動元の候補から外す
 */
export const MAX_WRITABLE_DECK_BYTES = 1_000_000;

export function deckJsonBytes(deck: Deck): number {
  return new TextEncoder().encode(`${JSON.stringify(deck, null, 2)}\n`).length;
}

export function isWritableDeck(deck: Deck): boolean {
  return deckJsonBytes(deck) <= MAX_WRITABLE_DECK_BYTES;
}

/**
 * カードの移動先にできるデッキ。**同じ群**（xlsx 生成デッキ同士 / 手書きデッキ同士）に限る。
 * 群をまたぐと decks:sync が「xlsx の行が消えた／増えた」と見て止まるため。
 * 自分自身と、Contents API で書けない大きさのデッキは除く。移動元が書けないときは空
 */
export function moveTargets(current: Deck, all: Deck[]): Deck[] {
  if (!isWritableDeck(current)) return [];
  const generated = isGeneratedDeck(current);
  return all
    .filter((deck) => deck.id !== current.id && isGeneratedDeck(deck) === generated && isWritableDeck(deck))
    .sort((left, right) => left.name.localeCompare(right.name, "ja"));
}

/**
 * 移動先を変えたときのタグの初期値。難易度と「出題済み」は引き継ぎ、小ジャンル系は落とす
 * （移動先の体系から選び直す）。手書きデッキ同士ではタグをそのまま引き継ぐ
 */
export function tagsForMove(tags: string[], generated: boolean): string[] {
  if (!generated) return tags;
  return tags.filter((tag) => isDifficultyTag(tag) || tag === SHUTSUDAI_TAG);
}
