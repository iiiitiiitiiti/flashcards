import { describe, expect, it } from "vitest";
import type { Deck } from "../src/deck";
import {
  buildStudyQueue,
  dayKey,
  DEFAULT_RATING_THRESHOLDS,
  NEW_CARDS_PER_DAY,
  normalizeRatingThresholds,
  previewIntervals,
  rate,
  ratingFromElapsed,
  validateProgressDTO,
} from "../src/srs";
import type { ProgressDTO, ProgressRecord } from "../src/types";

const NOW = new Date("2026-08-09T03:00:00Z");

function record(cardId: string, overrides: Partial<ProgressRecord> = {}, dto: Partial<ProgressDTO> = {}): ProgressRecord {
  return {
    deckId: "deck",
    cardId,
    progress: { ...rate(null, 3, new Date("2026-08-01T03:00:00Z")), ...dto },
    introducedDayKey: "2026-08-01",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("rate / ProgressDTO", () => {
  it("新規カードの評価で due が前進し reps が増える", () => {
    const progress = rate(null, 3, NOW);
    expect(progress.formatVersion).toBe(1);
    expect(progress.reps).toBe(1);
    expect(progress.due).toBeGreaterThan(NOW.getTime());
    expect(progress.lastReview).toBe(NOW.getTime());
  });

  it("「簡単」は「もう一度」より due が遠い", () => {
    const again = rate(null, 1, NOW);
    const easy = rate(null, 4, NOW);
    expect(easy.due).toBeGreaterThan(again.due);
  });

  it("評価を重ねても DTO が有限数値のまま保たれる（golden roundtrip）", () => {
    let progress: ProgressDTO | null = null;
    const ratings = [3, 1, 3, 4, 2, 3] as const;
    let clock = NOW.getTime();
    for (const rating of ratings) {
      progress = rate(progress, rating, new Date(clock));
      clock += 24 * 60 * 60 * 1000;
    }
    const validated = validateProgressDTO(JSON.parse(JSON.stringify(progress)));
    expect(validated).toEqual(progress);
    // 再度評価しても壊れない = fromDTO でスケジューラに戻せている
    expect(() => rate(validated, 3, new Date(clock))).not.toThrow();
  });

  it("validateProgressDTO が破損データを拒否する", () => {
    const valid = rate(null, 3, NOW);
    expect(() => validateProgressDTO({ ...valid, due: "2026-08-09" })).toThrow("due");
    expect(() => validateProgressDTO({ ...valid, stability: Number.NaN })).toThrow("stability");
    expect(() => validateProgressDTO({ ...valid, formatVersion: 2 })).toThrow("formatVersion");
    expect(() => validateProgressDTO({ ...valid, state: 9 })).toThrow("state");
    expect(() => validateProgressDTO(null)).toThrow("オブジェクト");
  });
});

describe("previewIntervals", () => {
  it("4評価すべての目安を返し、簡単ほど間隔が長い", () => {
    const preview = previewIntervals(null, NOW);
    expect(Object.keys(preview)).toHaveLength(4);
    for (const rating of [1, 2, 3, 4] as const) {
      expect(preview[rating]).toMatch(/^[\d.]+(分|時間|日|か月|年)$/);
    }
    // 評価適用後の実際の due とプレビューの単位系が一致することの緩い確認
    expect(rate(null, 4, NOW).due).toBeGreaterThan(rate(null, 1, NOW).due);
  });

  it("復習を重ねたカードでは日単位以上の間隔になる", () => {
    let progress = rate(null, 3, new Date("2026-07-01T03:00:00Z"));
    progress = rate(progress, 3, new Date("2026-07-05T03:00:00Z"));
    const preview = previewIntervals(progress, NOW);
    expect(preview[3]).toMatch(/(日|か月|年)$/);
  });
});

describe("dayKey（Asia/Tokyo 固定）", () => {
  it("JST の日付跨ぎを正しく扱う", () => {
    expect(dayKey(new Date("2026-08-09T14:59:00Z"))).toBe("2026-08-09");
    expect(dayKey(new Date("2026-08-09T15:00:00Z"))).toBe("2026-08-10");
  });
});

describe("buildStudyQueue", () => {
  function deck(cardIds: string[]): Deck {
    return {
      schemaVersion: 1,
      id: "deck",
      name: "テスト",
      cards: cardIds.map((id) => ({ id, front: `Q${id}`, back: `A${id}` })),
    };
  }

  it("期限切れカードを due 昇順で並べる", () => {
    const records = [
      record("a", {}, { due: NOW.getTime() - 1000 }),
      record("b", {}, { due: NOW.getTime() - 5000 }),
      record("c", {}, { due: NOW.getTime() + 60_000 }),
    ];
    const queue = buildStudyQueue(deck(["a", "b", "c"]), records, NOW);
    expect(queue.due.map((card) => card.id)).toEqual(["b", "a"]);
  });

  it("進捗のないカードを新規としてデッキ順に返し、日次上限を守る", () => {
    const ids = Array.from({ length: 15 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    const queue = buildStudyQueue(deck(ids), [], NOW);
    expect(queue.fresh).toHaveLength(NEW_CARDS_PER_DAY);
    expect(queue.fresh[0].id).toBe("c00");
    expect(queue.freshHeldBack).toBe(5);
  });

  it("今日すでに導入した枚数だけ新規上限を減らす", () => {
    const today = dayKey(NOW);
    const introduced = [record("a", { introducedDayKey: today }), record("b", { introducedDayKey: today })];
    const queue = buildStudyQueue(deck(["a", "b", "x", "y", "z"]), introduced, NOW);
    expect(queue.fresh.length).toBeLessThanOrEqual(NEW_CARDS_PER_DAY - 2);
    expect(queue.fresh.map((card) => card.id)).toEqual(["x", "y", "z"]);
  });

  it("上限到達後は新規を出さない", () => {
    const today = dayKey(NOW);
    const introduced = Array.from({ length: NEW_CARDS_PER_DAY }, (_, i) => record(`done${i}`, { introducedDayKey: today }));
    const queue = buildStudyQueue(deck(["new1", "new2"]), introduced, NOW);
    expect(queue.fresh).toHaveLength(0);
    expect(queue.freshHeldBack).toBe(2);
  });

  it("デッキから削除されたカードの孤児進捗を無視する", () => {
    const records = [record("deleted", {}, { due: NOW.getTime() - 1000 }), record("a", {}, { due: NOW.getTime() - 1000 })];
    const queue = buildStudyQueue(deck(["a"]), records, NOW);
    expect(queue.due.map((card) => card.id)).toEqual(["a"]);
  });

  it("空デッキで空のキューを返す", () => {
    const queue = buildStudyQueue(deck([]), [], NOW);
    expect(queue.due).toHaveLength(0);
    expect(queue.fresh).toHaveLength(0);
    expect(queue.freshHeldBack).toBe(0);
  });
});

describe("ratingFromElapsed / normalizeRatingThresholds", () => {
  // 既定値が変わっても境界の意味が壊れていないことを見るため、境界は明示して渡す
  const thresholds = { easy: 2, good: 5, hard: 10 };

  it("既定の境界は昇順で、問題表示からの秒数として現実的な範囲にある", () => {
    const { easy, good, hard } = DEFAULT_RATING_THRESHOLDS;
    expect(easy).toBeLessThan(good);
    expect(good).toBeLessThan(hard);
    expect(ratingFromElapsed((easy - 0.1) * 1000, DEFAULT_RATING_THRESHOLDS)).toBe(4);
    expect(ratingFromElapsed(hard * 1000, DEFAULT_RATING_THRESHOLDS)).toBe(1);
  });

  it("即答は「簡単」、迷うほど評価が下がる", () => {
    expect(ratingFromElapsed(0, thresholds)).toBe(4);
    expect(ratingFromElapsed(1_900, thresholds)).toBe(4);
    expect(ratingFromElapsed(2_000, thresholds)).toBe(3);
    expect(ratingFromElapsed(4_999, thresholds)).toBe(3);
    expect(ratingFromElapsed(5_000, thresholds)).toBe(2);
    expect(ratingFromElapsed(9_999, thresholds)).toBe(2);
    expect(ratingFromElapsed(10_000, thresholds)).toBe(1);
    expect(ratingFromElapsed(600_000, thresholds)).toBe(1);
  });

  it("負の経過時間（時計のずれ）は0として扱う", () => {
    expect(ratingFromElapsed(-5_000, thresholds)).toBe(4);
  });

  it("欠損・0以下・逆順の境界を昇順へ整える", () => {
    expect(normalizeRatingThresholds(null)).toEqual(DEFAULT_RATING_THRESHOLDS);
    expect(normalizeRatingThresholds({ easy: 0, good: -1, hard: Number.NaN })).toEqual(DEFAULT_RATING_THRESHOLDS);
    expect(normalizeRatingThresholds({ easy: 8, good: 3, hard: 1 })).toEqual({ easy: 8, good: 8, hard: 8 });
    expect(normalizeRatingThresholds({ easy: 1, good: 9999, hard: 9999 })).toEqual({ easy: 1, good: 600, hard: 600 });
  });
});
