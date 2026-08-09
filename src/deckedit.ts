import type { Deck, DeckCard } from "./deck";

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
