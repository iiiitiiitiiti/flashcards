import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "../src/deck";
import { decodeBase64Utf8, encodeBase64Utf8, moveCardBetweenDecks } from "../src/github";

function deckJson(id: string, cards: { id: string; front: string; back: string }[]): string {
  return `${JSON.stringify({ schemaVersion: 1, id, name: id, cards }, null, 2)}\n`;
}

function contentsResponse(raw: string, sha: string): Response {
  return new Response(JSON.stringify({ content: encodeBase64Utf8(raw), encoding: "base64", sha }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("moveCardBetweenDecks", () => {
  it("先に移動先へ追加し、次に元から削除する（途中で落ちても両方に残る側へ倒す）", async () => {
    const puts: { path: string; deck: Deck; message: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "GET") {
          if (url.includes("/decks/quiz-a.json")) return contentsResponse(deckJson("quiz-a", [{ id: "001", front: "問", back: "答" }]), "sha-a");
          return contentsResponse(deckJson("quiz-b", [{ id: "009", front: "他", back: "答" }]), "sha-b");
        }
        const body = JSON.parse(init?.body as string) as { content: string; message: string };
        puts.push({ path: url, deck: JSON.parse(decodeBase64Utf8(body.content)) as Deck, message: body.message });
        return new Response(JSON.stringify({ content: {} }), { status: 200 });
      }),
    );
    const card = { id: "001", front: "問（直した）", back: "答", tags: ["哺乳類", "★☆☆"] };
    const result = await moveCardBetweenDecks("quiz-a", "quiz-b", "token", card);

    expect(puts.map((put) => put.path.includes("quiz-b.json") ? "b" : "a")).toEqual(["b", "a"]);
    expect(puts[0].deck.cards.map((c) => c.id)).toEqual(["009", "001"]);
    expect(puts[0].deck.cards[1].front).toBe("問（直した）");
    expect(puts[0].message).toBe("deck(quiz-b): move card 001 from quiz-a");
    expect(puts[1].deck.cards).toEqual([]);
    expect(puts[1].message).toBe("deck(quiz-a): move card 001 to quiz-b");
    expect(result.to.id).toBe("quiz-b");
    expect(result.from.cards).toEqual([]);
  });

  it("同じデッキへの移動は拒否する", async () => {
    await expect(moveCardBetweenDecks("quiz-a", "quiz-a", "token", { id: "001", front: "問", back: "答" })).rejects.toThrow(/同じデッキ/);
  });
});
