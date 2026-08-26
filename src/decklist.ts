/** ホームのデッキ一覧の絞り込みと並び替え。表示ロジックだけを持つ純粋な関数 */

export type DeckSort = "recent" | "name" | "todo" | "learned";

export const DECK_SORTS: { value: DeckSort; label: string }[] = [
  { value: "recent", label: "最近学習した順" },
  { value: "name", label: "名前順" },
  { value: "todo", label: "学習できる枚数順" },
  { value: "learned", label: "定着率順" },
];

export interface DeckListItem {
  deckId: string;
  name: string;
  description?: string;
  cardCount: number;
  /** 今日学習できる枚数（復習＋新規） */
  todo: number;
  retentionPercent: number;
  /** この端末で最後に学習した時刻。未学習なら null */
  lastStudiedAt: number | null;
}

export function filterDecks<T extends DeckListItem>(items: T[], keyword: string): T[] {
  const needle = keyword.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) =>
    [item.name, item.description ?? ""].some((text) => text.toLowerCase().includes(needle)),
  );
}

export function sortDecks<T extends DeckListItem>(items: T[], sort: DeckSort): T[] {
  const byName = (left: T, right: T) => left.name.localeCompare(right.name, "ja");
  const sorted = [...items];
  switch (sort) {
    case "name":
      return sorted.sort(byName);
    case "todo":
      // 同数なら名前順。今日やることが無いデッキは自然と下へ落ちる
      return sorted.sort((left, right) => right.todo - left.todo || byName(left, right));
    case "learned":
      return sorted.sort((left, right) => right.retentionPercent - left.retentionPercent || byName(left, right));
    case "recent":
    default:
      // 未学習（null）は末尾へまとめ、その中では名前順にする
      return sorted.sort((left, right) => {
        if (left.lastStudiedAt === null && right.lastStudiedAt === null) return byName(left, right);
        if (left.lastStudiedAt === null) return 1;
        if (right.lastStudiedAt === null) return -1;
        return right.lastStudiedAt - left.lastStudiedAt || byName(left, right);
      });
  }
}
