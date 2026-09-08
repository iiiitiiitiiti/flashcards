// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsView } from "../src/SettingsView";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("設定画面の構成", () => {
  it("節はよく触る順に並び、長い説明は「説明を見る」に畳まれている", () => {
    const { container } = render(<SettingsView snapshot={null} />);
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual(["学習", "表示と動作", "バックアップ", "GitHub トークン", "メンテナンス"]);
    const helps = [...container.querySelectorAll("details.settings-help")] as HTMLDetailsElement[];
    expect(helps).toHaveLength(4);
    expect(helps.every((d) => !d.open)).toBe(true);
    // 畳んだ中にしか無い文言
    expect(screen.getByText(/fine-grained PAT/).closest("details")).not.toBeNull();
  });

  it("新規カードの説明は 1 行で、デッキ数があれば最大枚数を添える", () => {
    const snapshot = {
      decks: [
        { deckId: "a", deck: { id: "a", name: "A", cards: [] } },
        { deckId: "b", deck: { id: "b", name: "B", cards: [] } },
      ],
    } as unknown as Parameters<typeof SettingsView>[0]["snapshot"];
    render(<SettingsView snapshot={snapshot} />);
    expect(screen.getByText("デッキごとに1日 10 枚（2 デッキで最大 20 枚）。")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "無制限" }));
    expect(screen.getByText("「無制限」の間は、この単位の設定は効きません。")).not.toBeNull();
  });

  it("検索を開くブラウザを選ぶと保存される", () => {
    render(<SettingsView snapshot={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Vivaldi" }));
    expect(localStorage.getItem("flashcards:search-browser")).toBe("vivaldi");
    expect(screen.getByRole("button", { name: "Vivaldi" }).getAttribute("aria-pressed")).toBe("true");
  });
});
