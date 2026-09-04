// decks:sync の 3-way マージ。git も xlsx も触らない純関数だけを確かめる
import { describe, expect, it } from "vitest";
// @ts-expect-error scripts/ は型定義の無い ESM（Node 専用）
import { collectAppEdits, mergeDecks, sameCardContent } from "../scripts/merge-decks.mjs";

interface Card {
  id: string;
  front: string;
  back: string;
  note?: string;
  tags?: string[];
}
interface Deck {
  id: string;
  name: string;
  cards: Card[];
}

const SCOPE = ["quiz-a", "quiz-b"];

function deck(id: string, cards: Card[]): Deck {
  return { id, name: id, cards };
}
const card = (id: string, front: string, tags: string[] = ["小", "★☆☆"]): Card => ({ id, front, back: "答", tags });

describe("sameCardContent", () => {
  it("タグは順序を無視して比べる", () => {
    expect(sameCardContent(card("1", "q", ["a", "b"]), card("1", "q", ["b", "a"]))).toBe(true);
    expect(sameCardContent(card("1", "q", ["a"]), card("1", "q", ["a", "b"]))).toBe(false);
  });
  it("note は無いものと空文字を同じとみなす", () => {
    expect(sameCardContent({ ...card("1", "q"), note: "" }, card("1", "q"))).toBe(true);
  });
});

describe("collectAppEdits", () => {
  const base = [deck("quiz-a", [card("001", "問1"), card("002", "問2")]), deck("quiz-b", [card("003", "問3")]), deck("hand", [card("x", "手書き")])];

  it("編集・移動・追加・削除を分類し、対象外デッキは見ない", () => {
    const ours = [
      deck("quiz-a", [card("001", "問1 改"), { id: "new-uuid", front: "追加", back: "答" }]),
      deck("quiz-b", [card("003", "問3"), card("002", "問2")]),
      deck("hand", [card("x", "手書き 改")]),
    ];
    const edits = collectAppEdits(base, ours, SCOPE);
    const kinds = Object.fromEntries(edits.map((edit: { cardId: string; kind: string }) => [edit.cardId, edit.kind]));
    expect(kinds).toEqual({ "001": "edit", "002": "move", "new-uuid": "add" });
    const move = edits.find((edit: { kind: string }) => edit.kind === "move");
    expect(move.fromDeck).toBe("quiz-a");
    expect(move.toDeck).toBe("quiz-b");
  });

  it("消えたカードは remove になる", () => {
    const ours = [deck("quiz-a", [card("001", "問1")]), deck("quiz-b", [card("003", "問3")])];
    expect(collectAppEdits(base, ours, SCOPE).map((edit: { kind: string }) => edit.kind)).toEqual(["remove"]);
  });

  it("タグの順序だけが違うカードは編集扱いにしない", () => {
    const ours = [deck("quiz-a", [card("001", "問1", ["★☆☆", "小"]), card("002", "問2")]), deck("quiz-b", [card("003", "問3")])];
    expect(collectAppEdits(base, ours, SCOPE)).toEqual([]);
  });
});

describe("mergeDecks", () => {
  const base = [deck("quiz-a", [card("001", "問1"), card("002", "問2")]), deck("quiz-b", [card("003", "問3")])];
  const ours = [deck("quiz-a", [card("001", "問1 改")]), deck("quiz-b", [card("003", "問3"), card("002", "問2", ["別の小", "★☆☆"])])];
  const edits = collectAppEdits(base, ours, SCOPE);

  it("xlsx が変わっていなければ、編集と移動をそのまま生成結果へ当てる", () => {
    const theirs = structuredClone(base);
    const merged = mergeDecks(theirs, edits);
    expect(merged.conflicts).toEqual([]);
    expect(merged.applied).toHaveLength(2);
    const a = merged.decks.find((d: Deck) => d.id === "quiz-a");
    const b = merged.decks.find((d: Deck) => d.id === "quiz-b");
    expect(a.cards.map((c: Card) => c.id)).toEqual(["001"]);
    expect(a.cards[0].front).toBe("問1 改");
    expect(b.cards.map((c: Card) => c.id)).toEqual(["003", "002"]);
    expect(b.cards[1].tags).toEqual(["別の小", "★☆☆"]);
    // 入力は変更しない
    expect(theirs[0].cards).toHaveLength(2);
  });

  it("xlsx がすでに同じ内容なら何もしない（noop）", () => {
    const theirs = structuredClone(ours);
    const merged = mergeDecks(theirs, edits);
    expect(merged.applied).toEqual([]);
    expect(merged.noop).toHaveLength(2);
  });

  it("両側が変わっていれば衝突。既定では適用せず、'app' なら ours を通す", () => {
    const theirs = [deck("quiz-a", [card("001", "問1 xlsx側"), card("002", "問2")]), deck("quiz-b", [card("003", "問3")])];
    const stopped = mergeDecks(theirs, edits);
    expect(stopped.conflicts.map((c: { cardId: string }) => c.cardId)).toEqual(["001"]);
    expect(stopped.decks.find((d: Deck) => d.id === "quiz-a").cards[0].front).toBe("問1 xlsx側");
    expect(stopped.applied.map((e: { cardId: string }) => e.cardId)).toEqual(["002"]);

    const forced = mergeDecks(theirs, edits, { onConflict: "app" });
    expect(forced.decks.find((d: Deck) => d.id === "quiz-a").cards[0].front).toBe("問1 改");
  });

  it("追加カードは xlsx に行が無いので ours のデッキに残し、一覧に出す", () => {
    const withAdd = [deck("quiz-a", [card("001", "問1"), card("002", "問2"), { id: "uuid-1", front: "追加", back: "答" }]), deck("quiz-b", [card("003", "問3")])];
    const merged = mergeDecks(structuredClone(base), collectAppEdits(base, withAdd, SCOPE));
    expect(merged.decks.find((d: Deck) => d.id === "quiz-a").cards.map((c: Card) => c.id)).toEqual(["001", "002", "uuid-1"]);
    expect(merged.unmergeable[0].kind).toBe("add");
  });

  it("除外デッキが絡む変更は適用しない", () => {
    const merged = mergeDecks(structuredClone(base), edits, { excludeDecks: ["quiz-b"] });
    expect(merged.applied.map((e: { cardId: string }) => e.cardId)).toEqual(["001"]);
    expect(merged.unmergeable.map((e: { cardId: string }) => e.cardId)).toEqual(["002"]);
  });
});
