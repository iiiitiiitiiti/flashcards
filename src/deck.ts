export interface DeckCard {
  id: string;
  front: string;
  back: string;
  note?: string;
  tags?: string[];
}

export interface Deck {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  cards: DeckCard[];
}

// deck.id / card.id に許す文字。ファイル名・進捗キーにそのまま使うため制限する
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** id として使える文字列か。デッキ追加の入力チェックで使う */
export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function validateDeck(value: unknown, expectedId?: string): Deck {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("デッキがオブジェクトではありません");
  }
  const deck = value as Record<string, unknown>;
  if (deck.schemaVersion !== 1) {
    throw new Error(`未対応の schemaVersion です: ${String(deck.schemaVersion)}`);
  }
  if (typeof deck.id !== "string" || !ID_PATTERN.test(deck.id)) {
    throw new Error("id は英数字・ハイフン・アンダースコアの文字列が必須です");
  }
  if (expectedId !== undefined && deck.id !== expectedId) {
    throw new Error(`id「${deck.id}」がファイル名「${expectedId}」と一致しません`);
  }
  if (typeof deck.name !== "string" || deck.name.trim() === "") {
    throw new Error("name は空でない文字列が必須です");
  }
  if (deck.description !== undefined && typeof deck.description !== "string") {
    throw new Error("description は文字列で指定してください");
  }
  if (!Array.isArray(deck.cards)) {
    throw new Error("cards は配列が必須です");
  }
  const seenIds = new Set<string>();
  deck.cards.forEach((card, index) => {
    validateCard(card, index);
    if (seenIds.has(card.id)) {
      throw new Error(`カード id「${card.id}」が重複しています`);
    }
    seenIds.add(card.id);
  });
  return deck as unknown as Deck;
}

function validateCard(value: unknown, index: number): asserts value is DeckCard {
  const label = `cards[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} がオブジェクトではありません`);
  }
  const card = value as Record<string, unknown>;
  if (typeof card.id !== "string" || !ID_PATTERN.test(card.id)) {
    throw new Error(`${label}: id は英数字・ハイフン・アンダースコアの文字列が必須です`);
  }
  if (typeof card.front !== "string" || card.front.trim() === "") {
    throw new Error(`${label}: front は空でない文字列が必須です`);
  }
  if (typeof card.back !== "string" || card.back.trim() === "") {
    throw new Error(`${label}: back は空でない文字列が必須です`);
  }
  if (card.note !== undefined && typeof card.note !== "string") {
    throw new Error(`${label}: note は文字列で指定してください`);
  }
  if (card.tags !== undefined) {
    if (!Array.isArray(card.tags) || card.tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
      throw new Error(`${label}: tags は空でない文字列の配列で指定してください`);
    }
  }
}

/** 非表示のカードを取り除いたデッキ。学習にも統計にも、これを使う */
export function visibleDeck(deck: Deck, hiddenIds: Set<string> | undefined): Deck {
  if (!hiddenIds || hiddenIds.size === 0) return deck;
  return { ...deck, cards: deck.cards.filter((card) => !hiddenIds.has(card.id)) };
}
