/**
 * 全デッキをまたぐカード検索。ホームの検索欄から使う。
 * 3 万枚を入力ごとに正規化しないよう、索引（正規化済みの文字列）は最初に検索したときに作り、
 * デッキが変わったときだけ作り直す（呼び側の責務）。
 */
import type { Deck, DeckCard } from "./deck";

export interface CardHit {
  deckId: string;
  deckName: string;
  card: DeckCard;
}

export interface SearchIndexEntry extends CardHit {
  /** front・back・note を `normalizeSearchText` で揃えて改行で連結したもの */
  text: string;
}

/** 検索は 2 文字以上。1 文字だと 3 万枚のほとんどが当たり、デッキ名を打ち始めただけで長い一覧が出る */
export const SEARCH_MIN_LENGTH = 2;

/** 一覧に出す上限。それ以上は件数だけ伝える */
export const SEARCH_LIMIT = 50;

/**
 * 全角英数・半角カナの揺れを吸収する（NFKC）。大文字小文字も区別しない。
 * ひらがなとカタカナは別の文字のまま（「すもう」と「スモウ」は当たらない）
 */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim();
}

/** 空白で区切った語に分ける。全部含むカードだけ当てる（AND） */
export function searchTerms(keyword: string): string[] {
  return normalizeSearchText(keyword).split(/\s+/).filter((term) => term !== "");
}

/** 並びはデッキの並び → デッキ内のカード順。非表示のカードも入れる（既出確認が目的で、存在は見せる） */
export function buildSearchIndex(decks: Deck[]): SearchIndexEntry[] {
  const index: SearchIndexEntry[] = [];
  for (const deck of decks) {
    for (const card of deck.cards) {
      index.push({
        deckId: deck.id,
        deckName: deck.name,
        card,
        text: normalizeSearchText([card.front, card.back, card.note ?? ""].join("\n")),
      });
    }
  }
  return index;
}

export interface SearchResult {
  /** 先頭 `limit` 件 */
  hits: CardHit[];
  /** 該当した全件数 */
  total: number;
}

/** 検索できる長さか（語を全部つなげて 2 文字以上）。呼び側が索引を作るかの判断にも使う */
export function isSearchable(keyword: string): boolean {
  return searchTerms(keyword).join("").length >= SEARCH_MIN_LENGTH;
}

/** 語をすべて含むカード（AND）。`keyword` が短すぎれば検索せず空を返す */
export function searchCards(index: SearchIndexEntry[], keyword: string, limit = SEARCH_LIMIT): SearchResult {
  if (!isSearchable(keyword)) return { hits: [], total: 0 };
  const terms = searchTerms(keyword);
  const hits: CardHit[] = [];
  let total = 0;
  for (const entry of index) {
    if (!terms.every((term) => entry.text.includes(term))) continue;
    total += 1;
    if (hits.length < limit) hits.push({ deckId: entry.deckId, deckName: entry.deckName, card: entry.card });
  }
  return { hits, total };
}
