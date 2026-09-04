/**
 * ホームの検索結果から開く編集フォームの保存。App 用の薄いラッパで、
 * StudyView（キューの差し替えを伴う）と DeckDetailView（追加・削除・進捗リセットを伴う）は今も自前で持つ。
 * 3 か所の集約は別途。
 */
import type { Deck, DeckCard } from "./deck";
import { upsertCard } from "./deckedit";
import { moveCardLocalData } from "./db";
import { moveCardBetweenDecks, writeDeck } from "./github";

export interface CardEditOutcome {
  /** snapshot へ反映するデッキ。移動なら移動先・元の 2 つ */
  decks: Deck[];
  /** GitHub 側は済んだが端末側の進捗を移せなかったときの説明。それ以外は null */
  localMessage: string | null;
}

/**
 * カードを直して GitHub へ保存する。`targetDeckId` が違えば移動。
 * GitHub（正本）で失敗したら例外をそのまま投げる（呼び側がフォームにメッセージを出す）
 */
export async function saveCardEdit(deckId: string, card: DeckCard, targetDeckId: string, token: string): Promise<CardEditOutcome> {
  if (targetDeckId === deckId) {
    const next = await writeDeck(deckId, token, `deck(${deckId}): edit card ${card.id}`, (latest) => upsertCard(latest, card));
    return { decks: [next], localMessage: null };
  }
  const moved = await moveCardBetweenDecks(deckId, targetDeckId, token, card);
  let localMessage: string | null = null;
  try {
    await moveCardLocalData(deckId, targetDeckId, card.id);
  } catch (error) {
    // GitHub 側は移動済み。進捗だけ元デッキに残るので、その旨を伝える（次の学習では新規カードとして出る）
    localMessage = error instanceof Error ? error.message : "学習進捗を移せませんでした。";
  }
  return { decks: [moved.to, moved.from], localMessage };
}
