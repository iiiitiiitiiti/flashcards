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
  /** 区切り文字つきの1行。`parseTags` で配列にする */
  tags: string;
}

/**
 * フォームの内容からカードを作る。前後の空白は落とし、空の note / tags は**キーごと省く**
 * （デッキ JSON に空文字が残らないようにする）。id は呼び出し側が決める（既存カードは変えない）。
 */
export function buildCard(id: string, form: CardForm): DeckCard {
  const tags = parseTags(form.tags);
  return {
    id,
    front: form.front.trim(),
    back: form.back.trim(),
    ...(form.note.trim() !== "" ? { note: form.note.trim() } : {}),
    ...(tags ? { tags } : {}),
  };
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
