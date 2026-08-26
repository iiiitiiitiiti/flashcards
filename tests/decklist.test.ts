import { describe, expect, it } from "vitest";
import { filterDecks, sortDecks, type DeckListItem } from "../src/decklist";

function deck(name: string, overrides: Partial<DeckListItem> = {}): DeckListItem {
  return {
    deckId: name,
    name,
    cardCount: 10,
    todo: 0,
    retentionPercent: 0,
    lastStudiedAt: null,
    ...overrides,
  };
}

describe("sortDecks", () => {
  it("最近学習した順は新しい順、未学習は末尾で名前順", () => {
    const items = [
      deck("あ"),
      deck("い", { lastStudiedAt: 100 }),
      deck("う", { lastStudiedAt: 300 }),
      deck("え"),
      deck("お", { lastStudiedAt: 200 }),
    ];
    expect(sortDecks(items, "recent").map((d) => d.name)).toEqual(["う", "お", "い", "あ", "え"]);
  });

  it("同時刻なら名前順にそろえる", () => {
    const items = [deck("さ", { lastStudiedAt: 5 }), deck("か", { lastStudiedAt: 5 })];
    expect(sortDecks(items, "recent").map((d) => d.name)).toEqual(["か", "さ"]);
  });

  it("名前順・枚数順・定着率順", () => {
    const items = [
      deck("B", { todo: 3, retentionPercent: 10 }),
      deck("A", { todo: 30, retentionPercent: 5 }),
      deck("C", { todo: 3, retentionPercent: 80 }),
    ];
    expect(sortDecks(items, "name").map((d) => d.name)).toEqual(["A", "B", "C"]);
    expect(sortDecks(items, "todo").map((d) => d.name)).toEqual(["A", "B", "C"]);
    expect(sortDecks(items, "learned").map((d) => d.name)).toEqual(["C", "B", "A"]);
  });

  it("元の配列を壊さない", () => {
    const items = [deck("い"), deck("あ")];
    sortDecks(items, "name");
    expect(items.map((d) => d.name)).toEqual(["い", "あ"]);
  });
});

describe("filterDecks", () => {
  const items = [
    deck("クイズ: 理系", { description: "科学と数学" }),
    deck("クイズ: 地理", { description: "日本と世界" }),
  ];

  it("空の検索語では全件返す", () => {
    expect(filterDecks(items, "   ")).toHaveLength(2);
  });

  it("名前でも説明でも引ける", () => {
    expect(filterDecks(items, "理系").map((d) => d.name)).toEqual(["クイズ: 理系"]);
    expect(filterDecks(items, "日本").map((d) => d.name)).toEqual(["クイズ: 地理"]);
    expect(filterDecks(items, "クイズ")).toHaveLength(2);
    expect(filterDecks(items, "存在しない")).toHaveLength(0);
  });
});
