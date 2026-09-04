import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "../src/deck";

const github = vi.hoisted(() => ({
  writeDeck: vi.fn(),
  moveCardBetweenDecks: vi.fn(),
}));
const db = vi.hoisted(() => ({
  moveCardLocalData: vi.fn(),
}));
vi.mock("../src/github", () => github);
vi.mock("../src/db", () => db);

import { saveCardEdit } from "../src/cardactions";

function deck(id: string, cards: Deck["cards"]): Deck {
  return { schemaVersion: 1, id, name: id, cards };
}

const CARD = { id: "001", front: "問（直した）", back: "答" };

beforeEach(() => {
  github.writeDeck.mockReset();
  github.moveCardBetweenDecks.mockReset();
  db.moveCardLocalData.mockReset();
});

describe("saveCardEdit", () => {
  it("同じデッキなら writeDeck で upsert し、そのデッキだけ返す", async () => {
    github.writeDeck.mockImplementation(async (_id: string, _token: string, _message: string, update: (deck: Deck) => Deck) =>
      update(deck("quiz-a", [{ id: "001", front: "問", back: "答" }, { id: "002", front: "他", back: "答" }])),
    );
    const outcome = await saveCardEdit("quiz-a", CARD, "quiz-a", "token");
    expect(github.writeDeck).toHaveBeenCalledWith("quiz-a", "token", "deck(quiz-a): edit card 001", expect.any(Function));
    expect(outcome.decks).toHaveLength(1);
    expect(outcome.decks[0].cards.map((card) => card.front)).toEqual(["問（直した）", "他"]);
    expect(outcome.localMessage).toBeNull();
    expect(github.moveCardBetweenDecks).not.toHaveBeenCalled();
    expect(db.moveCardLocalData).not.toHaveBeenCalled();
  });

  it("別デッキなら移動し、移動先・元の順で返す。端末側も移す", async () => {
    github.moveCardBetweenDecks.mockResolvedValue({ to: deck("quiz-b", [CARD]), from: deck("quiz-a", []) });
    db.moveCardLocalData.mockResolvedValue(undefined);
    const outcome = await saveCardEdit("quiz-a", CARD, "quiz-b", "token");
    expect(github.moveCardBetweenDecks).toHaveBeenCalledWith("quiz-a", "quiz-b", "token", CARD);
    expect(db.moveCardLocalData).toHaveBeenCalledWith("quiz-a", "quiz-b", "001");
    expect(outcome.decks.map((d) => d.id)).toEqual(["quiz-b", "quiz-a"]);
    expect(outcome.localMessage).toBeNull();
  });

  it("端末側の移動だけ失敗したら、GitHub の結果は返しつつ localMessage で伝える", async () => {
    github.moveCardBetweenDecks.mockResolvedValue({ to: deck("quiz-b", [CARD]), from: deck("quiz-a", []) });
    db.moveCardLocalData.mockRejectedValue(new Error("容量が足りません"));
    const outcome = await saveCardEdit("quiz-a", CARD, "quiz-b", "token");
    expect(outcome.decks).toHaveLength(2);
    expect(outcome.localMessage).toBe("容量が足りません");
  });

  it("GitHub で失敗したら例外をそのまま投げ、端末側は触らない", async () => {
    github.moveCardBetweenDecks.mockRejectedValue(new Error("409"));
    await expect(saveCardEdit("quiz-a", CARD, "quiz-b", "token")).rejects.toThrow("409");
    expect(db.moveCardLocalData).not.toHaveBeenCalled();
  });
});
