import { describe, expect, it } from "vitest";
import { dayKey, rate } from "../src/srs";
import {
  buildMonthCells,
  isFutureMonth,
  shiftMonth,
  studiedDays,
  summarizeDay,
  summarizeTotal,
} from "../src/stats";
import type { ProgressRecord, ReviewLogEntry } from "../src/types";

/** 2026-08-26 12:00 JST */
const NOON = new Date("2026-08-26T03:00:00Z");
const TODAY = dayKey(NOON);

function log(overrides: Partial<ReviewLogEntry> = {}): ReviewLogEntry {
  return {
    reviewId: Math.random().toString(36).slice(2),
    deckId: "deck1",
    cardId: "001",
    rating: 3,
    reviewedAt: NOON.getTime(),
    elapsedMs: 60_000,
    ...overrides,
  };
}

function record(overrides: Partial<ProgressRecord> = {}, state = 2): ProgressRecord {
  return {
    deckId: "deck1",
    cardId: "001",
    progress: { ...rate(null, 3, NOON), state },
    introducedDayKey: TODAY,
    updatedAt: NOON.getTime(),
    ...overrides,
  };
}

describe("summarizeDay", () => {
  it("その日のログだけを数える", () => {
    const yesterday = new Date(NOON.getTime() - 86_400_000);
    const stats = summarizeDay(
      [log(), log(), log({ reviewedAt: yesterday.getTime() })],
      [record(), record({ cardId: "002" }), record({ cardId: "003", introducedDayKey: "2026-08-01" })],
      TODAY,
    );
    expect(stats.reviewedCards).toBe(2);
    expect(stats.newCards).toBe(2);
    expect(stats.playMinutes).toBe(2);
  });

  it("記録が無い日はすべて0", () => {
    expect(summarizeDay([], [], TODAY)).toEqual({ playMinutes: 0, reviewedCards: 0, newCards: 0 });
    expect(summarizeDay([log()], [record()], "2020-01-01")).toEqual({ playMinutes: 0, reviewedCards: 0, newCards: 0 });
  });

  it("elapsedMs を持たない古いログは時間に足さない", () => {
    const stats = summarizeDay([log({ elapsedMs: undefined }), log({ elapsedMs: undefined })], [], TODAY);
    expect(stats.reviewedCards).toBe(2);
    expect(stats.playMinutes).toBe(0);
  });

  it("1分未満でも学習していれば1分として出す", () => {
    expect(summarizeDay([log({ elapsedMs: 5_000 })], [], TODAY).playMinutes).toBe(1);
  });
});

describe("summarizeTotal", () => {
  const counts = new Map([
    ["deck1", 2],
    ["deck2", 3],
    ["empty", 0],
  ]);

  it("全期間のログと進捗を数える", () => {
    const stats = summarizeTotal(
      [log(), log({ deckId: "deck2" })],
      [record(), record({ cardId: "002" }), record({ deckId: "deck2", cardId: "001" }, 1)],
      counts,
    );
    expect(stats.reviewedCards).toBe(2);
    expect(stats.newCards).toBe(3);
    expect(stats.memorizedCards).toBe(2);
    expect(stats.playedDecks).toBe(2);
    // deck1 は2枚とも定着、deck2 は Learning が残っている
    expect(stats.memorizedDecks).toBe(1);
  });

  it("カード0枚のデッキは暗記済みにしない", () => {
    expect(summarizeTotal([], [], counts).memorizedDecks).toBe(0);
  });

  it("ログにしか出てこないデッキもプレイ済みに数える", () => {
    expect(summarizeTotal([log({ deckId: "消えたデッキ" })], [], counts).playedDecks).toBe(1);
  });

  it("記録が無ければすべて0", () => {
    expect(summarizeTotal([], [], new Map())).toEqual({
      playMinutes: 0,
      reviewedCards: 0,
      newCards: 0,
      memorizedCards: 0,
      playedDecks: 0,
      memorizedDecks: 0,
    });
  });
});

describe("studiedDays", () => {
  it("ログのある日を集める（同じ日は1つ）", () => {
    const other = new Date(NOON.getTime() - 3 * 86_400_000);
    const days = studiedDays([log(), log(), log({ reviewedAt: other.getTime() })]);
    expect(days.size).toBe(2);
    expect(days.has(TODAY)).toBe(true);
  });

  it("0件なら空", () => {
    expect(studiedDays([]).size).toBe(0);
  });
});

describe("buildMonthCells", () => {
  it("先頭の空きマスは1日の曜日ぶん、全体は7の倍数", () => {
    // 2026-08-01 は土曜日
    const cells = buildMonthCells(2026, 8);
    expect(cells.slice(0, 6).every((cell) => cell.day === null)).toBe(true);
    expect(cells[6]).toEqual({ day: 1, key: "2026-08-01" });
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((cell) => cell.day !== null)).toHaveLength(31);
  });

  it("1日が日曜なら空きマスが無い", () => {
    // 2026-02-01 は日曜日
    const cells = buildMonthCells(2026, 2);
    expect(cells[0]).toEqual({ day: 1, key: "2026-02-01" });
    expect(cells.filter((cell) => cell.day !== null)).toHaveLength(28);
  });

  it("うるう年の2月は29日", () => {
    expect(buildMonthCells(2024, 2).filter((cell) => cell.day !== null)).toHaveLength(29);
  });

  it("日付キーは dayKey と同じ書式（ゼロ埋め）", () => {
    expect(buildMonthCells(2026, 1)[4].key).toBe("2026-01-01");
  });
});

describe("shiftMonth", () => {
  it("年をまたぐ", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("同じ年の中では月だけ動く", () => {
    expect(shiftMonth(2026, 8, 1)).toEqual({ year: 2026, month: 9 });
    expect(shiftMonth(2026, 8, -1)).toEqual({ year: 2026, month: 7 });
  });
});

describe("isFutureMonth", () => {
  it("今月は未来ではない", () => {
    expect(isFutureMonth(2026, 8, NOON)).toBe(false);
  });

  it("翌月・翌年は未来", () => {
    expect(isFutureMonth(2026, 9, NOON)).toBe(true);
    expect(isFutureMonth(2027, 1, NOON)).toBe(true);
  });

  it("過去は未来ではない", () => {
    expect(isFutureMonth(2026, 7, NOON)).toBe(false);
    expect(isFutureMonth(2025, 12, NOON)).toBe(false);
  });
});
