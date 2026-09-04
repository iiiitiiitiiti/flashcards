import { describe, expect, it } from "vitest";
import type { Deck } from "../src/deck";
import { buildStudyQueue, dayKey, isWeakCard, rate, retentionPercent } from "../src/srs";
import {
  buildMonthCells,
  buildVisibleCardIndex,
  dueForecast,
  isFutureMonth,
  monthlyTrend,
  shiftMonth,
  studiedDays,
  summarizeDay,
  summarizeDecks,
  summarizeTotal,
  summarizeTrend,
  tallyByDay,
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

/** 日付キーの JST 境界。2026-08-26 23:59:59 JST と 2026-08-27 00:00:00 JST */
const LAST_SECOND_TODAY = new Date("2026-08-26T14:59:59Z").getTime();
const FIRST_SECOND_TOMORROW = new Date("2026-08-26T15:00:00Z").getTime();
const DAY = 86_400_000;

function deck(id: string, cardIds: string[], name = id): Deck {
  return { schemaVersion: 1, id, name, cards: cardIds.map((cardId) => ({ id: cardId, front: cardId, back: cardId })) };
}

/** 期限を指定した進捗（定着済み） */
function dueRecord(deckId: string, cardId: string, due: number, extra: Partial<ProgressRecord["progress"]> = {}): ProgressRecord {
  return record({ deckId, cardId, progress: { ...rate(null, 3, NOON), state: 2, due, ...extra } });
}

describe("tallyByDay / monthlyTrend / summarizeTrend", () => {
  it("日ごとにめくった枚数と正解数（「もう一度」以外）を数える", () => {
    const tally = tallyByDay([log({ rating: 3 }), log({ rating: 1 }), log({ rating: 2 }), log({ reviewedAt: NOON.getTime() - DAY, rating: 4 })]);
    expect(tally.get(TODAY)).toEqual({ reviewed: 3, correct: 2 });
    expect(tally.get("2026-08-25")).toEqual({ reviewed: 1, correct: 1 });
  });

  it("JST の日付境界で別の日になる", () => {
    const tally = tallyByDay([log({ reviewedAt: LAST_SECOND_TODAY }), log({ reviewedAt: FIRST_SECOND_TOMORROW })]);
    expect(tally.get("2026-08-26")?.reviewed).toBe(1);
    expect(tally.get("2026-08-27")?.reviewed).toBe(1);
  });

  it("月の日数ぶん返し、他の月のログは混ぜない", () => {
    const tally = tallyByDay([log(), log({ reviewedAt: new Date("2026-07-31T10:00:00Z").getTime() }), log({ reviewedAt: new Date("2026-09-01T10:00:00Z").getTime() })]);
    const days = monthlyTrend(tally, 2026, 8);
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({ key: "2026-08-01", day: 1, reviewed: 0, correct: 0 });
    expect(days[25]).toEqual({ key: "2026-08-26", day: 26, reviewed: 1, correct: 1 });
    expect(summarizeTrend(days)).toEqual({ reviewed: 1, correct: 1, percent: 100 });
    expect(monthlyTrend(tally, 2024, 2)).toHaveLength(29);
  });

  it("めくっていない月は正答率 null、正答率は四捨五入", () => {
    expect(summarizeTrend(monthlyTrend(new Map(), 2026, 8))).toEqual({ reviewed: 0, correct: 0, percent: null });
    expect(summarizeTrend([{ reviewed: 3, correct: 2 }])).toEqual({ reviewed: 3, correct: 2, percent: 67 });
  });
});

describe("dueForecast", () => {
  const index = buildVisibleCardIndex([deck("deck1", ["001", "002", "003", "004", "005"]), deck("deck2", ["001"])]);

  it("期限切れは今日に積み、いま復習できる枚数は due <= now で別に数える", () => {
    const records = [
      dueRecord("deck1", "001", NOON.getTime() - 30 * DAY), // ずっと前の期限切れ
      dueRecord("deck1", "002", NOON.getTime() - 1), // 直前に期限
      dueRecord("deck1", "003", LAST_SECOND_TODAY), // 今日中だが、まだ先
      dueRecord("deck1", "004", FIRST_SECOND_TOMORROW), // 明日の 0:00
    ];
    const forecast = dueForecast(records, index, NOON, 7);
    expect(forecast.days).toHaveLength(7);
    expect(forecast.days[0]).toEqual({ key: "2026-08-26", count: 3 });
    expect(forecast.days[1]).toEqual({ key: "2026-08-27", count: 1 });
    expect(forecast.dueNow).toBe(2);
  });

  it("今日を含めた days 日ぶんで、それより先は数えない", () => {
    const records = [
      dueRecord("deck1", "001", NOON.getTime() + 6 * DAY), // 7日目
      dueRecord("deck1", "002", NOON.getTime() + 7 * DAY), // 8日目（範囲外）
    ];
    const forecast = dueForecast(records, index, NOON, 7);
    expect(forecast.days[6]).toEqual({ key: "2026-09-01", count: 1 });
    expect(forecast.days.reduce((total, day) => total + day.count, 0)).toBe(1);
    expect(dueForecast(records, index, NOON, 30).days.reduce((total, day) => total + day.count, 0)).toBe(2);
  });

  it("索引に無いデッキ・カードは数えない（消えた・非表示）", () => {
    const records = [
      dueRecord("deck1", "999", NOON.getTime()),
      dueRecord("gone", "001", NOON.getTime()),
      dueRecord("deck2", "001", NOON.getTime()),
    ];
    expect(dueForecast(records, index, NOON, 7).days[0].count).toBe(1);
    expect(dueForecast(records, new Map(), NOON, 7).dueNow).toBe(0);
  });

  it("壊れた due は落とし、0 件なら 0 で埋まる", () => {
    const forecast = dueForecast([dueRecord("deck1", "001", Number.MAX_VALUE)], index, NOON, 3);
    expect(forecast.days.map((day) => day.count)).toEqual([0, 0, 0]);
    expect(forecast.dueNow).toBe(0);
  });
});

describe("summarizeDecks", () => {
  it("復習・苦手・定着率をデッキごとに数え、ホームと同じ値になる", () => {
    const deck1 = deck("deck1", ["001", "002", "003", "004"], "地理");
    const deck2 = deck("deck2", ["001", "002"], "世界史");
    const weak = { ...rate(null, 3, NOON), reps: 3, state: 1, due: NOON.getTime() + DAY };
    const records = [
      dueRecord("deck1", "001", NOON.getTime() - 1), // 復習
      record({ deckId: "deck1", cardId: "002", progress: weak }), // 苦手（期限は明日）
      dueRecord("deck1", "003", NOON.getTime() + DAY), // 定着・期限前
      dueRecord("deck1", "gone", NOON.getTime() - 1), // 消えたカード
      dueRecord("deck2", "001", NOON.getTime() - 1),
    ];
    const rows = summarizeDecks([deck1, deck2], records, NOON);
    expect(rows.map((row) => row.deckId)).toEqual(["deck1", "deck2"]);
    expect(rows[0]).toMatchObject({ name: "地理", cardCount: 4, due: 1, weak: 1 });
    expect(isWeakCard(weak)).toBe(true);
    expect(rows[0].due).toBe(buildStudyQueue(deck1, records.filter((r) => r.deckId === "deck1"), NOON, 10).due.length);
    const touched = records.filter((r) => r.deckId === "deck1" && r.cardId !== "gone").map((r) => r.progress);
    expect(rows[0].retentionPercent).toBe(retentionPercent(touched, 4));
    expect(rows[1]).toMatchObject({ name: "世界史", cardCount: 2, due: 1, weak: 0, retentionPercent: retentionPercent([records[4].progress], 2) });
  });

  it("並びは復習 → 苦手 → 名前。進捗が無いデッキは全部 0", () => {
    const decks = [deck("c", ["001"], "う"), deck("b", ["001"], "い"), deck("a", ["001"], "あ")];
    const weak = { ...rate(null, 3, NOON), reps: 3, state: 1, due: NOON.getTime() + DAY };
    const rows = summarizeDecks(decks, [record({ deckId: "b", cardId: "001", progress: weak })], NOON);
    expect(rows.map((row) => row.deckId)).toEqual(["b", "a", "c"]);
    expect(rows[1]).toMatchObject({ due: 0, weak: 0, retentionPercent: 0 });
  });

  it("出題対象が 0 枚のデッキでも壊れない", () => {
    expect(summarizeDecks([deck("empty", [])], [dueRecord("empty", "001", NOON.getTime())], NOON)[0]).toMatchObject({
      cardCount: 0,
      retentionPercent: 0,
      due: 0,
    });
  });
});
