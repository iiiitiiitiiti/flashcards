import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "../src/deck";
import { upsertCard } from "../src/deckedit";
import { decodeBase64Utf8, encodeBase64Utf8, writeDeck } from "../src/github";

function deckJson(front: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id: "alpha",
      name: "デッキ",
      cards: [{ id: "001", front, back: "答" }],
    },
    null,
    2,
  )}\n`;
}

function contentsResponse(raw: string, sha: string): Response {
  return new Response(JSON.stringify({ content: encodeBase64Utf8(raw), encoding: "base64", sha }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("writeDeck", () => {
  it("最新版へ変更を適用して PUT する", async () => {
    const calls: { method: string; body: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", body: (init?.body as string) ?? null });
        if ((init?.method ?? "GET") === "GET") return contentsResponse(deckJson("問"), "sha-1");
        return new Response(JSON.stringify({ content: {} }), { status: 200 });
      }),
    );
    const result = await writeDeck("alpha", "token", "msg", (deck: Deck) => upsertCard(deck, { id: "002", front: "追加", back: "答2" }));
    expect(result.cards).toHaveLength(2);

    const put = calls.find((call) => call.method === "PUT");
    expect(put).toBeDefined();
    const body = JSON.parse(put?.body ?? "{}") as { sha: string; content: string; message: string };
    expect(body.sha).toBe("sha-1");
    expect(body.message).toBe("msg");
    const written = JSON.parse(decodeBase64Utf8(body.content)) as Deck;
    expect(written.cards.map((card) => card.id)).toEqual(["001", "002"]);
  });

  it("409 のたびに最新版を再取得して再適用する", async () => {
    let generation = 0;
    let putCount = 0;
    const putShas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") {
          generation += 1;
          return contentsResponse(deckJson(`問v${generation}`), `sha-${generation}`);
        }
        putCount += 1;
        putShas.push((JSON.parse(init?.body as string) as { sha: string }).sha);
        if (putCount < 3) return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
        return new Response(JSON.stringify({ content: {} }), { status: 200 });
      }),
    );
    const result = await writeDeck("alpha", "token", "msg", (deck: Deck) => upsertCard(deck, { id: "002", front: "追加", back: "答2" }));
    // 3回目の PUT は3回目に取得した最新版（sha-3）へ適用されている
    expect(putShas).toEqual(["sha-1", "sha-2", "sha-3"]);
    expect(result.cards.find((card) => card.id === "001")?.front).toBe("問v3");
  });

  it("409 が続いたら3回で断念する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return contentsResponse(deckJson("問"), "sha-1");
        return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
      }),
    );
    await expect(writeDeck("alpha", "token", "msg", (deck: Deck) => deck)).rejects.toThrow("競合");
  });

  it("変更後のデッキが規約違反なら PUT せずに失敗する", async () => {
    let putCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return contentsResponse(deckJson("問"), "sha-1");
        putCount += 1;
        return new Response(JSON.stringify({ content: {} }), { status: 200 });
      }),
    );
    await expect(
      writeDeck("alpha", "token", "msg", (deck: Deck) => ({ ...deck, cards: [...deck.cards, { id: "001", front: "重複", back: "x" }] })),
    ).rejects.toThrow("重複");
    expect(putCount).toBe(0);
  });

  it("401 は再試行せずエラーにする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return contentsResponse(deckJson("問"), "sha-1");
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      }),
    );
    await expect(writeDeck("alpha", "token", "msg", (deck: Deck) => deck)).rejects.toThrow("401");
  });
});

describe("base64 helpers", () => {
  it("日本語・絵文字を往復できる", () => {
    const text = "日本語テキスト🍣改行\nタブ\t";
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);
  });
});

describe("writeDeck（1MB 超のデッキ）", () => {
  it("Contents API が本文を返さないときは Blob API で本文を取り、同じ sha で PUT する", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.github.com", "")}`);
        if ((init?.method ?? "GET") === "GET" && url.includes("/contents/")) {
          // 1MB 超: content は空・encoding は "none"・sha だけ返る（2026-09-04 実 API で確認）
          return new Response(JSON.stringify({ content: "", encoding: "none", sha: "big-sha", size: 1_153_842 }), { status: 200 });
        }
        if ((init?.method ?? "GET") === "GET" && url.includes("/git/blobs/big-sha")) {
          // Blob API の base64 は 60 文字ごとに改行が入る
          const encoded = encodeBase64Utf8(deckJson("大きい")).replace(/(.{60})/g, "$1\n");
          return new Response(JSON.stringify({ content: encoded, encoding: "base64", sha: "big-sha" }), { status: 200 });
        }
        return new Response(JSON.stringify({ content: {} }), { status: 200 });
      }),
    );
    const result = await writeDeck("alpha", "token", "msg", (deck: Deck) => upsertCard(deck, { id: "002", front: "追加", back: "答2" }));
    expect(result.cards.map((card) => card.front)).toEqual(["大きい", "追加"]);
    expect(calls).toEqual([
      "GET /repos/iiiitiiitiiti/flashcards/contents/decks/alpha.json?ref=main",
      "GET /repos/iiiitiiitiiti/flashcards/git/blobs/big-sha",
      "PUT /repos/iiiitiiitiiti/flashcards/contents/decks/alpha.json",
    ]);
  });
});
