/** カード一覧の1ページあたりの表示枚数 */
export const CARDS_PER_PAGE = 30;

/** ページャに並べる要素。数値はページ番号、null は省略（…） */
export type PageItem = number | null;

/** 1..count のうち、先頭・末尾・現在の前後を残して省略したページャ項目を返す */
export function buildPageItems(current: number, count: number): PageItem[] {
  if (count <= 0) return [];
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  const pages = new Set<number>([1, count]);
  for (let page = current - 1; page <= current + 1; page += 1) {
    if (page >= 1 && page <= count) pages.add(page);
  }
  // 端に寄ったときも項目数が減りすぎないように補う
  if (current <= 3) [2, 3, 4].forEach((page) => pages.add(page));
  if (current >= count - 2) [count - 3, count - 2, count - 1].forEach((page) => pages.add(page));

  const sorted = [...pages].sort((left, right) => left - right);
  const items: PageItem[] = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous !== 0 && page - previous > 1) items.push(null);
    items.push(page);
    previous = page;
  }
  return items;
}

/** 表示中のページを 1..count の範囲へ収める（絞り込みでページ数が減ったとき用） */
export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, page), Math.max(1, count));
}
