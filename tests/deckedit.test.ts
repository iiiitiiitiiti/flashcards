import { describe, expect, it } from "vitest";
import type { Deck } from "../src/deck";
import { appendCards, upsertCard } from "../src/deckedit";

function deck(): Deck {
  return {
    schemaVersion: 1,
    id: "deck",
    name: "テスト",
    cards: [
      { id: "001", front: "問1", back: "答1" },
      { id: "002", front: "問2", back: "答2" },
    ],
  };
}

describe("upsertCard", () => {
  it("新しい id のカードを末尾に追加する", () => {
    const next = upsertCard(deck(), { id: "003", front: "問3", back: "答3" });
    expect(next.cards.map((card) => card.id)).toEqual(["001", "002", "003"]);
  });

  it("既存 id のカードを位置を保って置換する", () => {
    const next = upsertCard(deck(), { id: "001", front: "改", back: "答1" });
    expect(next.cards[0].front).toBe("改");
    expect(next.cards).toHaveLength(2);
  });

  it("元のデッキを変更しない（純関数）", () => {
    const original = deck();
    upsertCard(original, { id: "003", front: "問3", back: "答3" });
    expect(original.cards).toHaveLength(2);
  });
});

describe("appendCards", () => {
  it("新規カードだけを追加し、既存 id はスキップする（冪等）", () => {
    const incoming = [
      { id: "002", front: "重複", back: "重複" },
      { id: "003", front: "問3", back: "答3" },
    ];
    const first = appendCards(deck(), incoming);
    expect(first.appended).toBe(1);
    expect(first.skipped).toBe(1);
    expect(first.deck.cards.map((card) => card.id)).toEqual(["001", "002", "003"]);
    // 同じ操作を再適用しても増えない（再試行安全）
    const second = appendCards(first.deck, incoming);
    expect(second.appended).toBe(0);
    expect(second.deck.cards).toHaveLength(3);
  });

  it("全件既存ならデッキをそのまま返す", () => {
    const original = deck();
    const result = appendCards(original, [{ id: "001", front: "x", back: "y" }]);
    expect(result.deck).toBe(original);
  });
});
