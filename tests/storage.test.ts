import { beforeEach, describe, expect, it } from "vitest";

// vitest の既定環境（node）には localStorage が無いので最小限の実装を置く
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});
import { loadNewCardsPerDay, loadSessionSize, loadStudyOrder, saveNewCardsPerDay, saveStudyOrder } from "../src/storage";
import { NEW_CARDS_PER_DAY } from "../src/srs";

describe("loadNewCardsPerDay", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未設定なら既定枚数を返す（0＝無制限に化けない）", () => {
    expect(loadNewCardsPerDay()).toBe(NEW_CARDS_PER_DAY);
  });

  it("保存した選択肢をそのまま返す。0（無制限）も保持する", () => {
    saveNewCardsPerDay(50);
    expect(loadNewCardsPerDay()).toBe(50);
    saveNewCardsPerDay(0);
    expect(loadNewCardsPerDay()).toBe(0);
  });

  it("選択肢にない値は既定へ落とす", () => {
    localStorage.setItem("flashcards:new-cards-per-day", "7");
    expect(loadNewCardsPerDay()).toBe(NEW_CARDS_PER_DAY);
    localStorage.setItem("flashcards:new-cards-per-day", "あ");
    expect(loadNewCardsPerDay()).toBe(NEW_CARDS_PER_DAY);
  });

  it("学習枚数も未設定なら既定（20枚）を返す", () => {
    expect(loadSessionSize()).toBe(20);
  });
});

describe("loadStudyOrder", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未設定ならランダム", () => {
    expect(loadStudyOrder()).toBe("random");
  });

  it("保存した値を返す", () => {
    saveStudyOrder("sequential");
    expect(loadStudyOrder()).toBe("sequential");
    saveStudyOrder("random");
    expect(loadStudyOrder()).toBe("random");
  });

  it("壊れた値はランダムへ落とす", () => {
    localStorage.setItem("flashcards:study-order", "でたらめ");
    expect(loadStudyOrder()).toBe("random");
  });
});
