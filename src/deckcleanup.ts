/**
 * デッキを削除したあとの、端末側の後片付け。
 *
 * 消すものが IndexedDB（`deleteDeckLocalData`）と localStorage（出題タグの記憶）に分かれているので、
 * ここで1つにまとめる。**何度呼んでもよい**（消えていれば何もしない）。
 *
 * GitHub の削除に成功してから後片付けが終わるまでの間にアプリが落ちると孤児レコードが残り、
 * 同じ id でデッキを作り直したときに古い進捗が再接続されてしまう（2026-08-28 Codex 指摘）。
 * `addPendingDeckDeletion` の印を頼りに、起動時へ持ち越して再開する。
 */
import { deleteDeckLocalData } from "./db";
import { loadPendingDeckDeletions, removePendingDeckDeletion, saveStudyTag } from "./storage";

export async function cleanUpDeletedDeck(deckId: string): Promise<void> {
  await deleteDeckLocalData(deckId);
  // 出題タグの記憶だけ localStorage 側にある
  saveStudyTag(deckId, null);
  removePendingDeckDeletion(deckId);
}

/**
 * 前回の削除が後片付けの途中で終わっていたら、やり直す。
 * 失敗しても起動は続ける（印が残るので次回また試す）。
 */
export async function resumePendingDeckDeletions(): Promise<void> {
  for (const deckId of loadPendingDeckDeletions()) {
    try {
      await cleanUpDeletedDeck(deckId);
    } catch {
      // 次回起動時にもう一度試す
    }
  }
}
