import { describe, expect, it } from "vitest";
import type { Deck } from "../src/deck";
import {
  retentionPercent,
  buildStudyQueue,
  isWeakCard,
  countIntroducedToday,
  dayKey,
  DEFAULT_RATING_THRESHOLDS,
  NEW_CARDS_PER_DAY,
  normalizeRatingThresholds,
  previewIntervals,
  rate,
  ratingFromElapsed,
  shuffled,
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

describe("shuffled", () => {
  it("元の配列を変えず、要素は過不足なく保たれる", () => {
    const source = Array.from({ length: 50 }, (_, i) => i);
    const result = shuffled(source);
    expect(source).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect([...result].sort((a, b) => a - b)).toEqual(source);
  });

  it("空配列・1要素でも壊れない", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(["a"])).toEqual(["a"]);
  });

  it("十分な長さなら並びが変わる（同一順のままではない）", () => {
    const source = Array.from({ length: 100 }, (_, i) => i);
    const results = Array.from({ length: 5 }, () => shuffled(source).join(","));
    expect(results.some((r) => r !== source.join(","))).toBe(true);
  });
});

describe("retentionPercent（定着率）", () => {
  const review = (reps: number) => ({ reps, state: 2 });
  const learning = (reps: number) => ({ reps, state: 1 });

  it("フェーズ10かつ定着なら満点、未学習だけなら0%", () => {
    expect(retentionPercent([review(10), review(10), review(10)], 3)).toBe(100);
    expect(retentionPercent([{ reps: 0, state: 0 }], 1)).toBe(0);
  });

  it("定着したカードのフェーズ合計 ÷ (枚数 × 10) で計算する", () => {
    expect(retentionPercent([review(5), review(5)], 2)).toBe(50);
    expect(retentionPercent([review(1)], 2)).toBe(5);
    expect(retentionPercent([review(10), learning(0)], 4)).toBe(25);
  });

  it("定着していないカードは、フェーズが進んでいても数えない", () => {
    // 「もう一度」を10回続けた状態（reps=10 だが state は Learning のまま）
    expect(retentionPercent([learning(10), learning(10)], 2)).toBe(0);
    expect(retentionPercent([review(10), learning(10)], 2)).toBe(50);
  });

  it("フェーズ10を超えても満点扱いにし、100%を超えない", () => {
    expect(retentionPercent([review(30), review(30)], 2)).toBe(100);
    expect(retentionPercent([review(20), learning(0)], 2)).toBe(50);
  });

  it("カードが0枚なら0%（0除算しない）", () => {
    expect(retentionPercent([], 0)).toBe(0);
  });

  it("負のフェーズは0として扱う", () => {
    expect(retentionPercent([review(-5), review(10)], 2)).toBe(50);
  });
});

describe("buildStudyQueue のタグ絞り込み", () => {
  function taggedDeck(cards: Record<string, string[]>): Deck {
    return {
      schemaVersion: 1,
      id: "deck",
      name: "テスト",
      cards: Object.entries(cards).map(([id, tags]) => ({ id, front: `Q${id}`, back: `A${id}`, tags })),
    };
  }

  const deck = taggedDeck({ a: ["難易度A", "地理"], b: ["難易度B"], c: ["難易度A"] });

  it("タグを指定すると、そのタグのカードだけを新規に出す", () => {
    const queue = buildStudyQueue(deck, [], NOW, 10, "難易度A");
    expect(queue.fresh.map((card) => card.id)).toEqual(["a", "c"]);
  });

  it("復習キューも同じタグで絞る", () => {
    const records = [
      record("a", {}, { due: NOW.getTime() - 1000 }),
      record("b", {}, { due: NOW.getTime() - 5000 }),
    ];
    const queue = buildStudyQueue(deck, records, NOW, 10, "難易度A");
    expect(queue.due.map((card) => card.id)).toEqual(["a"]);
  });

  it("null と空文字は絞り込まない（select の未選択）", () => {
    expect(buildStudyQueue(deck, [], NOW, 10, null).fresh).toHaveLength(3);
    expect(buildStudyQueue(deck, [], NOW, 10, "").fresh).toHaveLength(3);
  });

  it("どのカードも持たないタグでは0枚になる", () => {
    const queue = buildStudyQueue(deck, [], NOW, 10, "存在しない");
    expect(queue.due).toHaveLength(0);
    expect(queue.fresh).toHaveLength(0);
    expect(queue.freshHeldBack).toBe(0);
  });

  it("タグを持たないカードは、タグ指定時に必ず外れる", () => {
    const mixed: Deck = {
      schemaVersion: 1,
      id: "deck",
      name: "テスト",
      cards: [{ id: "a", front: "Q", back: "A" }, { id: "b", front: "Q", back: "A", tags: ["理科"] }],
    };
    expect(buildStudyQueue(mixed, [], NOW, 10, "理科").fresh.map((card) => card.id)).toEqual(["b"]);
  });

  it("新規の1日上限はデッキ全体で数える（タグを変えても枠は増えない）", () => {
    const today = dayKey(NOW);
    // 今日すでに他のタグで2枚導入している
    const introduced = [
      record("b", { introducedDayKey: today }),
      record("x", { introducedDayKey: today }),
    ];
    const queue = buildStudyQueue(deck, introduced, NOW, 3, "難易度A");
    expect(queue.fresh.map((card) => card.id)).toEqual(["a"]);
    expect(queue.freshHeldBack).toBe(1);
  });

  it("全角・絵文字のタグでも一致する", () => {
    const emoji = taggedDeck({ a: ["★難しい"], b: ["👨‍👩‍👧‍👦家族"] });
    expect(buildStudyQueue(emoji, [], NOW, 10, "👨‍👩‍👧‍👦家族").fresh.map((card) => card.id)).toEqual(["b"]);
    expect(buildStudyQueue(emoji, [], NOW, 10, "★難しい").fresh.map((card) => card.id)).toEqual(["a"]);
  });
});

describe("新規枠を全デッキ合計で数える（usedNewCardsToday）", () => {
  function deck(cardIds: string[]): Deck {
    return {
      schemaVersion: 1,
      id: "deck",
      name: "テスト",
      cards: cardIds.map((id) => ({ id, front: `Q${id}`, back: `A${id}` })),
    };
  }

  const five = deck(["a", "b", "c", "d", "e"]);

  it("渡さなければ、これまでどおりこのデッキの進捗から数える", () => {
    const today = dayKey(NOW);
    const introduced = [record("a", { introducedDayKey: today })];
    expect(buildStudyQueue(five, introduced, NOW, 3).fresh).toHaveLength(2);
  });

  it("渡した枚数だけ枠を減らす（他デッキで使ったぶんを反映）", () => {
    // このデッキでは1枚も出していないが、他デッキで今日3枚出している
    expect(buildStudyQueue(five, [], NOW, 3, null, 3).fresh).toHaveLength(0);
    expect(buildStudyQueue(five, [], NOW, 5, null, 3).fresh).toHaveLength(2);
  });

  it("使った枚数が上限を超えていても負の枠にならない", () => {
    expect(buildStudyQueue(five, [], NOW, 3, null, 10).fresh).toHaveLength(0);
  });

  it("0（無制限）は単位に関係なく全部出す", () => {
    expect(buildStudyQueue(five, [], NOW, 0, null, 999).fresh).toHaveLength(5);
  });

  it("0 を渡した場合は「まだ1枚も使っていない」として扱う", () => {
    const today = dayKey(NOW);
    // このデッキには今日ぶんの進捗があるが、外から 0 を渡したらそちらを優先する
    const introduced = [record("a", { introducedDayKey: today }), record("b", { introducedDayKey: today })];
    expect(buildStudyQueue(five, introduced, NOW, 3, null, 0).fresh).toHaveLength(3);
  });

  it("タグで絞っても、枠の消費数は渡された値のまま", () => {
    const tagged: Deck = {
      schemaVersion: 1,
      id: "deck",
      name: "テスト",
      cards: [
        { id: "a", front: "Q", back: "A", tags: ["理科"] },
        { id: "b", front: "Q", back: "A", tags: ["理科"] },
        { id: "c", front: "Q", back: "A", tags: ["地理"] },
      ],
    };
    expect(buildStudyQueue(tagged, [], NOW, 3, "理科", 2).fresh.map((card) => card.id)).toEqual(["a"]);
  });
});

describe("countIntroducedToday", () => {
  it("今日はじめて出したカードだけを数える", () => {
    const today = dayKey(NOW);
    const records = [
      record("a", { introducedDayKey: today }),
      record("b", { introducedDayKey: today }),
      record("c", { introducedDayKey: "2026-08-01" }),
    ];
    expect(countIntroducedToday(records, NOW)).toBe(2);
  });

  it("0件なら0", () => {
    expect(countIntroducedToday([], NOW)).toBe(0);
  });

  it("デッキをまたいでも数える（全デッキ合計で使う）", () => {
    const today = dayKey(NOW);
    const records = [
      record("a", { deckId: "deck1", introducedDayKey: today }),
      record("a", { deckId: "deck2", introducedDayKey: today }),
    ];
    expect(countIntroducedToday(records, NOW)).toBe(2);
  });
});

describe("苦手カード（isWeakCard / buildStudyQueue focus=weak）", () => {
  function deck(cardIds: string[], tags: Record<string, string[]> = {}): Deck {
    return {
      schemaVersion: 1,
      id: "deck",
      name: "テスト",
      cards: cardIds.map((id) => ({ id, front: `Q${id}`, back: `A${id}`, tags: tags[id] })),
    };
  }
  const REVIEW = 2;
  const LEARNING = 1;
  const yesterday = new Date("2026-08-08T03:00:00Z").getTime();
  /** 定着済みで問題のないカード */
  const solid = { lapses: 0, reps: 10, difficulty: 4, scheduledDays: 5, state: REVIEW };

  it("3回以上出しても定着していないカードは苦手。2回ならまだ苦手ではない", () => {
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, reps: 3, state: LEARNING })).toBe(true);
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, reps: 2, state: LEARNING })).toBe(false);
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, reps: 3 })).toBe(false);
  });

  it("忘れたことがあるカード（lapses ≥ 1）は苦手。ただし間隔が 21 日以上になったら外れる", () => {
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, lapses: 1 })).toBe(true);
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, lapses: 1, scheduledDays: 20 })).toBe(true);
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, lapses: 3, scheduledDays: 21 })).toBe(false);
  });

  it("Review のまま「難しい」を押し続けて難しさが 8 以上のカードも苦手（lapses は増えない）", () => {
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, difficulty: 8 })).toBe(true);
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, difficulty: 7.9 })).toBe(false);
    expect(isWeakCard({ ...rate(null, 3, NOW), ...solid, difficulty: 9.5, scheduledDays: 30 })).toBe(false);
  });

  it("実際の FSRS 遷移: 学習中に「もう一度」を続けると lapses は増えないが苦手になる", () => {
    let progress = rate(null, 1, NOW);
    expect(isWeakCard(progress)).toBe(false);
    progress = rate(progress, 1, new Date(progress.due + 1000));
    expect(progress.lapses).toBe(0);
    // 2回目の「もう一度」で難しさが 8 を超える（実測 8.8）
    expect(isWeakCard(progress)).toBe(true);
  });

  it("実際の FSRS 遷移: 順調に覚えたカードは苦手ではなく、定着後に1回忘れると苦手になる", () => {
    let progress = rate(null, 3, NOW);
    progress = rate(progress, 3, new Date(progress.due + 1000));
    progress = rate(progress, 4, new Date(progress.due + 1000));
    expect(progress.state).toBe(REVIEW);
    expect(isWeakCard(progress)).toBe(false);
    progress = rate(progress, 1, new Date(progress.due + 1000));
    expect(progress.lapses).toBe(1);
    expect(isWeakCard(progress)).toBe(true);
  });

  it("苦手だけを、忘れた回数 → 難しさの降順で返す。期限前でも出し、新規は含めない", () => {
    const far = NOW.getTime() + 30 * 86_400_000;
    const records = [
      record("a", {}, { ...solid, lapses: 1, difficulty: 5, due: far, lastReview: yesterday }),
      record("b", {}, { ...solid, lapses: 3, difficulty: 4, due: far, lastReview: yesterday }),
      record("c", {}, { ...solid, lapses: 1, difficulty: 9, due: far, lastReview: yesterday }),
      record("d", {}, { ...solid, due: NOW.getTime() - 1000, lastReview: yesterday }),
      record("e", {}, { ...solid, reps: 4, difficulty: 7, state: LEARNING, due: far, lastReview: yesterday }),
    ];
    const queue = buildStudyQueue(deck(["a", "b", "c", "d", "e", "fresh"]), records, NOW, 10, null, undefined, "weak");
    expect(queue.due.map((card) => card.id)).toEqual(["b", "c", "a", "e"]);
    expect(queue.fresh).toEqual([]);
    expect(queue.freshHeldBack).toBe(0);
  });

  it("weakSince 以降に評価したカードは除く（「つづける」で同じカードを繰り返さない）。null なら除かない", () => {
    const since = NOW.getTime() - 10 * 60_000;
    const records = [
      record("a", {}, { ...solid, lapses: 2, lastReview: NOW.getTime() - 60_000 }),
      record("b", {}, { ...solid, lapses: 2, lastReview: since - 1 }),
      record("c", {}, { ...solid, lapses: 2, lastReview: null }),
    ];
    const withSince = buildStudyQueue(deck(["a", "b", "c"]), records, NOW, 10, null, undefined, "weak", since);
    expect(withSince.due.map((card) => card.id)).toEqual(["b", "c"]);
    const withoutSince = buildStudyQueue(deck(["a", "b", "c"]), records, NOW, 10, null, undefined, "weak");
    expect(withoutSince.due.map((card) => card.id)).toEqual(["a", "b", "c"]);
  });

  it("タグで絞れる", () => {
    const records = [
      record("a", {}, { ...solid, lapses: 1, lastReview: yesterday }),
      record("b", {}, { ...solid, lapses: 1, lastReview: yesterday }),
    ];
    const queue = buildStudyQueue(deck(["a", "b"], { a: ["x"], b: ["y"] }), records, NOW, 10, "x", undefined, "weak");
    expect(queue.due.map((card) => card.id)).toEqual(["a"]);
  });

  it("focus を省略すると従来どおり（期限切れ＋新規）", () => {
    const records = [record("a", {}, { ...solid, lapses: 3, due: NOW.getTime() + 60_000, lastReview: yesterday })];
    const queue = buildStudyQueue(deck(["a", "b"]), records, NOW);
    expect(queue.due).toEqual([]);
    expect(queue.fresh.map((card) => card.id)).toEqual(["b"]);
  });
});
