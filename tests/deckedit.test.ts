import { describe, expect, it } from "vitest";
import type { Deck } from "../src/deck";
import { appendCards, collectDeckTags, moveTargets, removeCard, tagsForMove, toggleTag, upsertCard, validateGeneratedTags } from "../src/deckedit";

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

describe("collectDeckTags", () => {
  it("件数の多い順、同数は辞書順で返す", () => {
    const tagged: Deck = {
      ...deck(),
      cards: [
        { id: "001", front: "問1", back: "答1", tags: ["ラン科", "★★☆"] },
        { id: "002", front: "問2", back: "答2", tags: ["イヌ科", "★★☆"] },
        { id: "003", front: "問3", back: "答3" },
      ],
    };
    expect(collectDeckTags(tagged)).toEqual([
      { tag: "★★☆", count: 2 },
      { tag: "イヌ科", count: 1 },
      { tag: "ラン科", count: 1 },
    ]);
  });

  it("タグが1つも無ければ空", () => {
    expect(collectDeckTags(deck())).toEqual([]);
  });
});

describe("toggleTag / removeCard", () => {
  it("toggleTag は付け外しを切り替え、元の配列を変えない", () => {
    const tags = ["a"];
    expect(toggleTag(tags, "b")).toEqual(["a", "b"]);
    expect(toggleTag(tags, "a")).toEqual([]);
    expect(tags).toEqual(["a"]);
  });

  it("removeCard は指定 id だけを除き、無ければ同じデッキを返す", () => {
    const original = deck();
    expect(removeCard(original, "001").cards.map((card) => card.id)).toEqual(["002"]);
    expect(removeCard(original, "zzz")).toBe(original);
  });
});

describe("validateGeneratedTags", () => {
  it("小ジャンル1つ + 難易度1つ + 出題済み は通る", () => {
    expect(validateGeneratedTags(["植物･果物", "★☆☆", "出題済み"])).toBeNull();
    expect(validateGeneratedTags(["植物･果物"])).toBeNull();
  });
  it("小ジャンルが無い・複数・難易度が複数は止める", () => {
    expect(validateGeneratedTags(["★☆☆"])).toMatch(/1つ選んで/);
    expect(validateGeneratedTags(["植物･果物", "哺乳類"])).toMatch(/1つだけ/);
    expect(validateGeneratedTags(["植物･果物", "★☆☆", "★★☆"])).toMatch(/難易度/);
  });
});

describe("moveTargets / tagsForMove", () => {
  const generated = (id: string): Deck => ({ schemaVersion: 1, id, name: id, description: "クイズ.xlsx「ノンジャンルクイズ」より 1 問", cards: [] });
  const hand = (id: string): Deck => ({ schemaVersion: 1, id, name: id, cards: [] });

  it("同じ群のデッキだけを、自分を除いて名前順に返す", () => {
    const all = [generated("quiz-b"), generated("quiz-a"), hand("kanji"), generated("quiz-c")];
    expect(moveTargets(generated("quiz-c"), all).map((deck) => deck.id)).toEqual(["quiz-a", "quiz-b"]);
    expect(moveTargets(hand("kanji"), all)).toEqual([]);
  });

  it("上限を超えるデッキは候補から外し、移動元が超えていれば空", () => {
    const huge: Deck = { ...generated("quiz-huge"), cards: Array.from({ length: 200 }, (_, index) => ({ id: String(index), front: "あ".repeat(30), back: "い".repeat(10) })) };
    const all = [huge, generated("quiz-a"), generated("quiz-b")];
    // 上限を小さくして挙動だけ確かめる（既定の 100MB はテストで作れない）
    expect(moveTargets(generated("quiz-a"), all, 10_000).map((deck) => deck.id)).toEqual(["quiz-b"]);
    expect(moveTargets(huge, all, 10_000)).toEqual([]);
    // 既定の上限では 1MB 級のデッキも候補に入る（Blob API で読めるため）
    expect(moveTargets(generated("quiz-a"), all).map((deck) => deck.id)).toEqual(["quiz-b", "quiz-huge"]);
  });

  it("生成デッキ間の移動では小ジャンルを落として難易度と出題済みを残す", () => {
    expect(tagsForMove(["植物･果物", "★☆☆", "出題済み"], true)).toEqual(["★☆☆", "出題済み"]);
    expect(tagsForMove(["自由", "★☆☆"], false)).toEqual(["自由", "★☆☆"]);
  });
});
