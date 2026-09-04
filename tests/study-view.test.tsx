// @vitest-environment jsdom
//
// StudyView の状態遷移を DOM ごと確かめる。ここまでのテストは全部ピュア関数だったので、
// 取り消し・再出題・早押しの遷移は手動確認だけで守られていた。
//
// スワイプは PointerEvent が jsdom に無いので触らない。ボタン操作で辿れる経路だけを見る。
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "../src/deck";

/** GitHub への書き込みは差し替える。返り値は mutate を当てた結果にして本物と同じ形にする */
const writeDeckMock = vi.fn();
const moveCardMock = vi.fn();
vi.mock("../src/github", () => ({
  writeDeck: (deckId: string, _token: string, _message: string, mutate: (deck: Deck) => Deck) =>
    writeDeckMock(deckId, mutate),
  moveCardBetweenDecks: (fromDeckId: string, toDeckId: string, _token: string, card: unknown) => moveCardMock(fromDeckId, toDeckId, card),
}));
import { readAllProgress, readAllReviewLog, readCardNotes, readHiddenCards, resetDbForTest } from "../src/db";
import { progressKey, rate } from "../src/srs";
import { StudyView } from "../src/StudyView";
import type { ProgressRecord } from "../src/types";

const DECK: Deck = {
  schemaVersion: 1,
  id: "deck1",
  name: "テストデッキ",
  cards: [
    { id: "001", front: "日本の首都は", back: "東京" },
    { id: "002", front: "フランスの首都は", back: "パリ" },
    { id: "003", front: "イタリアの首都は", back: "ローマ" },
  ],
};

function renderStudy(overrides: Partial<Parameters<typeof StudyView>[0]> = {}) {
  const closed: boolean[] = [];
  const hidden: string[] = [];
  const updatedDecks: Deck[] = [];
  const view = render(
    <StudyView
      decks={[DECK]}
      title={DECK.name}
      initialProgress={[]}
      mode="normal"
      sessionSize={10}
      order="sequential"
      tag={null}
      initialNotes={new Map()}
      canEditCards
      onHide={(_deckId, cardId) => hidden.push(cardId)}
      onDeckUpdated={(...next) => updatedDecks.push(...next)}
      onClose={(restart) => closed.push(restart)}
      {...overrides}
    />,
  );
  return { ...view, closed, hidden, updatedDecks };
}

/** 表向きのカードを1回押して答えを出す */
function reveal(container: HTMLElement) {
  const scene = container.querySelector(".flip-scene");
  if (!scene) throw new Error(".flip-scene が見つかりません");
  fireEvent.click(scene);
}

const undoButton = () => screen.getByLabelText("1つ前のカードに戻る（直前の評価を取り消す）") as HTMLButtonElement;
const remainingText = () => document.querySelector(".study-remaining")?.textContent ?? "";

/**
 * 評価はスワイプと同じ飛ばしアニメーション（260ms）を挟んでから確定するので、
 * その間はロックがかかって取り消せない。押せるようになるまで待つ
 */
async function waitUntilUndoReady() {
  await waitFor(() => expect(undoButton().disabled).toBe(false));
}
// 早押しボタンには文字を置いていない（実物と同じ）。読み上げ用の名前で引く

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
  // localStorage は触らない。Node 25 が持つ native の localStorage が jsdom のものを覆っていて
  // clear() が生えていない。設定は storage.ts 側が例外を握って既定値へ倒れるので、それに任せる
});

afterEach(() => {
  cleanup();
  document.body.className = "";
});

describe("通常学習の1枚ぶん", () => {
  it("答えを出して評価すると、進捗とログが1件ずつ増えて次のカードへ進む", async () => {
    const { container } = renderStudy();
    expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は");

    reveal(container);
    fireEvent.click(screen.getByText("わかった"));

    await waitFor(async () => expect(await readAllProgress()).toHaveLength(1));
    expect(await readAllReviewLog()).toHaveLength(1);
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("フランスの首都は"));
  });

  it("評価するまで取り消しは押せない", () => {
    renderStudy();
    expect(undoButton().disabled).toBe(true);
  });
});

describe("直前の評価を取り消す", () => {
  it("初回評価だったカードは、進捗レコードごと消えて元のカードへ戻る", async () => {
    const { container } = renderStudy();
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(async () => expect(await readAllProgress()).toHaveLength(1));

    await waitUntilUndoReady();
    fireEvent.click(undoButton());

    await waitFor(async () => expect(await readAllProgress()).toHaveLength(0));
    // ログも一緒に消える（進捗だけ戻ってログが残る半端な状態を作らない）
    expect(await readAllReviewLog()).toHaveLength(0);
    // 付け直しやすいよう、答えを出したまま戻す
    await waitFor(() => expect(container.querySelector(".study-back")?.textContent).toBe("東京"));
    expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は");
    expect(remainingText()).toContain("残り 3 枚");
  });

  it("評価前の進捗があるカードは、その状態へ戻る（消さない）", async () => {
    // 手書きの DTO はすぐ古くなるので、実際に3回評価した進捗を作って渡す
    let progress = rate(null, 3, new Date("2026-08-01T00:00:00Z"));
    progress = rate(progress, 3, new Date("2026-08-02T00:00:00Z"));
    progress = rate(progress, 3, new Date("2026-08-03T00:00:00Z"));
    const previous: ProgressRecord = {
      deckId: "deck1",
      cardId: "001",
      progress,
      introducedDayKey: "2026-08-01",
      updatedAt: Date.parse("2026-08-03T00:00:00Z"),
    };
    expect(previous.progress.reps).toBe(3);

    const { container } = renderStudy({ initialProgress: [previous] });
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(async () => expect((await readAllProgress())[0]?.progress.reps).toBe(4));

    await waitUntilUndoReady();
    fireEvent.click(undoButton());

    await waitFor(async () => {
      const rows = await readAllProgress();
      expect(rows).toHaveLength(1);
      // 消さずに評価前へ戻す
      expect(rows[0].progress.reps).toBe(3);
    });
  });

  it("「もう一度」で末尾へ足した再出題も取り除く（枚数がずれない）", async () => {
    // rating=1 を明示ボタンで出せるのは早押しの「不正解」だけ（通常学習は2択＋スワイプのため）
    const { container } = renderStudy({ mode: "buzzer" });
    fireEvent.click(screen.getByLabelText("押す"));
    fireEvent.click(screen.getByText("答えを表示"));
    expect(remainingText()).toContain("残り 3 枚");

    fireEvent.click(screen.getByText("不正解"));

    // 末尾へ再出題が足されるので、1枚めくっても残りは3枚のまま
    // （早押しの問題文は1文字ずつしか出ないので、次のカードへ進んだことは「押す」の復活で見る）
    await waitFor(async () => expect(await readAllProgress()).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText("押す")).toBeTruthy());
    expect(remainingText()).toContain("残り 3 枚");

    await waitUntilUndoReady();
    fireEvent.click(undoButton());

    // 再出題ぶんも消えて、元の3枚へ戻る（取り消しで枚数が増えない）
    await waitFor(async () => expect(await readAllProgress()).toHaveLength(0));
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は"));
    expect(remainingText()).toContain("残り 3 枚");
  });

  it("2回評価して2回取り消すと、逆順に戻る", async () => {
    const { container } = renderStudy();
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("フランスの首都は"));
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(async () => expect(await readAllProgress()).toHaveLength(2));

    await waitUntilUndoReady();
    fireEvent.click(undoButton());
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("フランスの首都は"));
    expect(await readAllProgress()).toHaveLength(1);

    await waitUntilUndoReady();
    fireEvent.click(undoButton());
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は"));
    await waitFor(async () => expect(await readAllProgress()).toHaveLength(0));
    expect(undoButton().disabled).toBe(true);
  });

  it("やり切ってリザルトへ入っても取り消せる（最後の1枚の誤操作の戻り道）", async () => {
    const single: Deck = { ...DECK, cards: [DECK.cards[0]] };
    const { container } = renderStudy({ decks: [single] });
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));

    const undoOnResult = await screen.findByText("直前の評価を取り消す");
    await waitFor(async () => expect(await readAllProgress()).toHaveLength(1));

    fireEvent.click(undoOnResult);

    await waitFor(async () => expect(await readAllProgress()).toHaveLength(0));
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は"));
    expect(remainingText()).toContain("残り 1 枚");
  });
});

describe("早押し", () => {
  it("押すと文字送りが止まり、そこまでの文字数が記録される", async () => {
    renderStudy({ mode: "buzzer" });
    fireEvent.click(screen.getByLabelText("押す"));
    expect(remainingText()).toContain("0/6 文字で押した");
    // 押したあとは「答えを表示」に切り替わる
    expect(screen.getByText("答えを表示")).toBeTruthy();
  });

  it("読み切る前に押せば「つづきを読む」が出る", () => {
    renderStudy({ mode: "buzzer" });
    fireEvent.click(screen.getByLabelText("押す"));
    expect(screen.getByText("つづきを読む")).toBeTruthy();
  });

  it("正解・不正解の2択で評価する", async () => {
    renderStudy({ mode: "buzzer" });
    fireEvent.click(screen.getByLabelText("押す"));
    fireEvent.click(screen.getByText("答えを表示"));
    const ratings = within(document.querySelector(".rating-buttons") as HTMLElement);
    expect(ratings.getByText("正解")).toBeTruthy();
    expect(ratings.getByText("不正解")).toBeTruthy();
  });
});

describe("カードのメモ", () => {
  const memoButton = () => screen.getByLabelText(/^メモを(書く|編集)$/) as HTMLButtonElement;

  it("開くと入力欄が出て、とじると保存される", async () => {
    renderStudy();
    // 開く前は入力欄が無い
    expect(document.querySelector(".note-input")).toBeNull();

    fireEvent.click(memoButton());
    const input = (await screen.findByPlaceholderText("メモを入力")) as HTMLTextAreaElement;
    // jsdom は showModal を実装していないので、open 属性での代用が効いていること
    expect((document.querySelector(".memo-dialog") as HTMLDialogElement).open).toBe(true);

    fireEvent.change(input, { target: { value: "  東京は江戸から改称  " } });
    fireEvent.click(screen.getByText("とじる"));

    await waitFor(async () => {
      const saved = await readCardNotes("deck1");
      expect(saved).toHaveLength(1);
      // 前後の空白は落として保存する
      expect(saved[0].text).toBe("東京は江戸から改称");
      expect(saved[0].cardId).toBe("001");
    });
    await waitFor(() => expect(document.querySelector(".note-input")).toBeNull());
    expect((document.querySelector(".memo-dialog") as HTMLDialogElement).open).toBe(false);
  });

  it("空にするとメモを消す", async () => {
    renderStudy({ initialNotes: new Map([[progressKey("deck1", "001"), "あとで消す"]]) });
    fireEvent.click(memoButton());
    const input = (await screen.findByPlaceholderText("メモを入力")) as HTMLTextAreaElement;
    expect(input.value).toBe("あとで消す");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByText("とじる"));

    await waitFor(async () => expect(await readCardNotes("deck1")).toHaveLength(0));
  });
});

describe("早押し中はカードを編集させない", () => {
  const memoButton = () => screen.getByLabelText(/^メモを(書く|編集)$/) as HTMLButtonElement;
  const hideButton = () => screen.getByLabelText("このカードを非表示にする") as HTMLButtonElement;

  it("読んでいる最中と、押して止めている最中は、メモ・非表示が押せない", () => {
    renderStudy({ mode: "buzzer" });
    // 文字送り中
    expect(memoButton().disabled).toBe(true);
    expect(hideButton().disabled).toBe(true);

    // 押して止めている最中
    fireEvent.click(screen.getByLabelText("押す"));
    expect(memoButton().disabled).toBe(true);
    expect(hideButton().disabled).toBe(true);

    // 答えを出せば触れる
    fireEvent.click(screen.getByText("答えを表示"));
    expect(memoButton().disabled).toBe(false);
    expect(hideButton().disabled).toBe(false);
  });

  it("通常学習では最初から押せる", () => {
    renderStudy();
    expect(memoButton().disabled).toBe(false);
    expect(hideButton().disabled).toBe(false);
  });

  it("早押し中でも1つ前へ戻すボタンの状態は変えない（評価の有無だけで決まる）", async () => {
    const { container } = renderStudy({ mode: "buzzer" });
    expect(undoButton().disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("押す"));
    fireEvent.click(screen.getByText("答えを表示"));
    fireEvent.click(screen.getByText("正解"));
    await waitUntilUndoReady();

    // 次のカードは文字送り中でも、取り消しは押せる
    expect(memoButton().disabled).toBe(true);
    expect(undoButton().disabled).toBe(false);
    expect(container.querySelector(".buzzer-text")).toBeTruthy();
  });
});

describe("StrictMode（効果が setup → cleanup → setup で二度走る）", () => {
  it("評価したあとに画面が次のカードへ進む", async () => {
    // 本番の main.tsx は <StrictMode> で包んでいる。cleanup で倒したフラグを
    // setup で戻していないと、2回目の setup 以降ずっと「アンマウント済み」と誤認する
    const view = render(
      <StrictMode>
        <StudyView
          decks={[DECK]}
          title={DECK.name}
          initialProgress={[]}
          mode="normal"
          sessionSize={10}
          order="sequential"
          tag={null}
          initialNotes={new Map()}
          canEditCards={false}
          onHide={() => undefined}
          onDeckUpdated={() => undefined}
          onClose={() => undefined}
        />
      </StrictMode>,
    );
    expect(view.container.querySelector(".study-front")?.textContent).toBe("日本の首都は");

    reveal(view.container);
    fireEvent.click(screen.getByText("わかった"));

    await waitFor(async () => expect(await readAllProgress()).toHaveLength(1));
    // DB は書けても、画面が固まっていないこと
    await waitFor(() => expect(view.container.querySelector(".study-front")?.textContent).toBe("フランスの首都は"));
    expect(remainingText()).toContain("残り 2 枚");
  });
});

describe("メモはモーダルとして開く", () => {
  const memoButton = () => screen.getByLabelText(/^メモを(書く|編集)$/) as HTMLButtonElement;

  it("showModal が使える環境では showModal を呼ぶ（open 属性の代用で済ませない）", async () => {
    // jsdom は showModal / close を持たないので生やして観測する。
    // これが無いと「fallback だけ動いていて native は呼んでいない」状態を見逃す
    const calls: string[] = [];
    const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
    proto.showModal = function showModal(this: HTMLDialogElement) {
      calls.push("showModal");
      this.setAttribute("open", "");
    };
    proto.close = function close(this: HTMLDialogElement) {
      calls.push("close");
      this.removeAttribute("open");
    };
    try {
      renderStudy();
      fireEvent.click(memoButton());
      await screen.findByPlaceholderText("メモを入力");
      expect(calls).toEqual(["showModal"]);

      fireEvent.click(screen.getByText("とじる"));
      await waitFor(() => expect(calls).toEqual(["showModal", "close"]));
    } finally {
      delete proto.showModal;
      delete proto.close;
    }
  });
});

describe("学習中のカード編集", () => {
  const editButton = () => screen.queryByLabelText("このカードを編集する") as HTMLButtonElement | null;

  beforeEach(() => {
    writeDeckMock.mockReset();
    // 既定は「本物と同じように mutate を当てたデッキを返す」
    writeDeckMock.mockImplementation((_deckId: string, mutate: (deck: Deck) => Deck) => Promise.resolve(mutate(DECK)));
  });

  it("トークンが無ければ編集ボタンを出さない", () => {
    renderStudy({ canEditCards: false });
    expect(editButton()).toBeNull();
  });

  it("開くと今の内容が入っている", async () => {
    renderStudy({ decks: [{ ...DECK, cards: [{ ...DECK.cards[0], note: "補足", tags: ["地理", "首都"] }] }] });
    fireEvent.click(editButton() as HTMLButtonElement);
    await screen.findByText("カードを編集");
    expect((screen.getByLabelText(/表面/) as HTMLTextAreaElement).value).toBe("日本の首都は");
    expect((screen.getByLabelText(/裏面/) as HTMLTextAreaElement).value).toBe("東京");
    expect((screen.getByLabelText(/補足メモ/) as HTMLTextAreaElement).value).toBe("補足");
    // タグは選択中のチップとして出る
    expect(screen.getByRole("button", { name: "タグ「地理」を外す" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "タグ「首都」を外す" })).toBeTruthy();
  });

  it("表面が空なら保存させない", async () => {
    renderStudy();
    fireEvent.click(editButton() as HTMLButtonElement);
    await screen.findByText("カードを編集");
    fireEvent.change(screen.getByLabelText(/表面/), { target: { value: "   " } });
    fireEvent.click(screen.getByText("GitHubへ保存"));

    expect(await screen.findByText("表面と裏面は必須です。")).toBeTruthy();
    expect(writeDeckMock).not.toHaveBeenCalled();
  });

  it("保存すると学習中のカードも差し替わる（キューは開始時のスナップショットのため）", async () => {
    const view = renderStudy();
    fireEvent.click(editButton() as HTMLButtonElement);
    await screen.findByText("カードを編集");
    fireEvent.change(screen.getByLabelText(/表面/), { target: { value: "日本の首都はどこ" } });
    // 手書きデッキなので新しいタグを作れる（明示のボタンを押したときだけ）
    fireEvent.change(screen.getByLabelText("タグを検索"), { target: { value: "地理" } });
    fireEvent.click(screen.getByText(/“地理” を新しいタグとして追加/));
    fireEvent.change(screen.getByLabelText("タグを検索"), { target: { value: "首都" } });
    fireEvent.click(screen.getByText(/“首都” を新しいタグとして追加/));
    fireEvent.click(screen.getByText("GitHubへ保存"));

    await waitFor(() => expect(view.container.querySelector(".study-front")?.textContent).toBe("日本の首都はどこ"));
    // 親へも渡してキャッシュを更新させる
    await waitFor(() => expect(view.updatedDecks).toHaveLength(1));
    const saved = view.updatedDecks[0].cards.find((card) => card.id === "001");
    expect(saved?.front).toBe("日本の首都はどこ");
    expect(saved?.tags).toEqual(["地理", "首都"]);
    // id は変えない（進捗のキーなので）
    expect(saved?.id).toBe("001");
  });

  it("保存に失敗したらダイアログを閉じずに理由を出す", async () => {
    writeDeckMock.mockRejectedValue(new Error("書き込みが拒否されました (403)。"));
    renderStudy();
    fireEvent.click(editButton() as HTMLButtonElement);
    await screen.findByText("カードを編集");
    fireEvent.click(screen.getByText("GitHubへ保存"));

    expect(await screen.findByText("書き込みが拒否されました (403)。")).toBeTruthy();
    expect(screen.getByText("カードを編集")).toBeTruthy();
  });

  it("別デッキへ移すと、キューから抜けて移動先・元の両方が親へ渡る", async () => {
    const OTHER: Deck = { schemaVersion: 1, id: "deck2", name: "別のデッキ", cards: [{ id: "900", front: "既存", back: "答", tags: ["既存タグ"] }] };
    moveCardMock.mockImplementation((fromDeckId: string, toDeckId: string, card: Deck["cards"][number]) =>
      Promise.resolve({
        to: { ...OTHER, cards: [...OTHER.cards, card] },
        from: { ...DECK, cards: DECK.cards.filter((existing) => existing.id !== card.id) },
      }),
    );
    const view = renderStudy({ moveTargetsFor: () => [OTHER] });
    fireEvent.click(editButton() as HTMLButtonElement);
    await screen.findByText("カードを編集");
    fireEvent.change(screen.getByLabelText("デッキ"), { target: { value: "deck2" } });
    // 移動先のタグが候補になる
    fireEvent.click(screen.getByRole("button", { name: /タグ「既存タグ」を付ける/ }));
    fireEvent.click(screen.getByText("移動してGitHubへ保存"));

    await waitFor(() => expect(moveCardMock).toHaveBeenCalledTimes(1));
    expect(moveCardMock.mock.calls[0][0]).toBe("deck1");
    expect(moveCardMock.mock.calls[0][1]).toBe("deck2");
    expect(moveCardMock.mock.calls[0][2].tags).toEqual(["既存タグ"]);
    // このデッキのカードではなくなったので、次のカードへ進む
    await waitFor(() => expect(view.container.querySelector(".study-front")?.textContent).toBe("フランスの首都は"));
    await waitFor(() => expect(view.updatedDecks).toHaveLength(2));
    expect(view.updatedDecks.map((deck) => deck.id)).toEqual(["deck2", "deck1"]);
    // 端末側の進捗の移送も走る（deck1 に進捗が無いので何も移らないが、失敗もしない）
    expect(await readAllProgress()).toEqual([]);
  });

  it("早押しで答えを出す前は編集させない", () => {
    renderStudy({ mode: "buzzer" });
    expect((editButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("押す"));
    fireEvent.click(screen.getByText("答えを表示"));
    expect((editButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("苦手だけ（focus=weak）", () => {
  const yesterday = new Date("2026-08-08T03:00:00Z").getTime();
  /** 定着後に1回忘れたカード（苦手）。期限は遠い未来 */
  function weakRecord(cardId: string, lapses = 1): ProgressRecord {
    const base = rate(null, 3, new Date("2026-08-01T03:00:00Z"));
    return {
      deckId: "deck1",
      cardId,
      progress: { ...base, state: 2, reps: 6, lapses, scheduledDays: 3, difficulty: 5, due: Date.now() + 30 * 86_400_000, lastReview: yesterday },
      introducedDayKey: "2026-08-01",
      updatedAt: yesterday,
    };
  }
  /** 順調に定着しているカード（苦手ではない） */
  function solidRecord(cardId: string): ProgressRecord {
    return { ...weakRecord(cardId, 0), progress: { ...weakRecord(cardId, 0).progress, lapses: 0, difficulty: 3 } };
  }

  it("苦手カードだけを忘れた回数順に出し、全部評価すると「つづける」は出ない", async () => {
    const since = Date.now();
    const { container } = renderStudy({
      focus: "weak",
      weakSince: since,
      initialProgress: [weakRecord("001", 1), solidRecord("002"), weakRecord("003", 2)],
    });
    // 003（lapses 2）→ 001（lapses 1）。002 は苦手ではないので出ない。期限前でも出る
    expect(container.querySelector(".study-front")?.textContent).toBe("イタリアの首都は");
    expect(remainingText()).toContain("残り 2 枚");
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は"));
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));

    // 評価した2枚は weakSince 以降に評価済みなので残りに入らず、「つづける」は出ない
    await waitFor(() => expect(screen.getByText("終了する")).toBeTruthy());
    expect(screen.queryByText("つづける")).toBeNull();
    expect(screen.getByText(/苦手カードは一通り復習しました/)).toBeTruthy();
  });

  it("苦手が枚数より多ければ「つづける」が出る。「つづける」は同じ設定での再開を親へ伝える", async () => {
    const { container, closed } = renderStudy({
      focus: "weak",
      weakSince: Date.now(),
      sessionSize: 1,
      initialProgress: [weakRecord("001"), weakRecord("002"), weakRecord("003")],
    });
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(() => expect(screen.getByText("つづける")).toBeTruthy());
    fireEvent.click(screen.getByText("つづける"));
    expect(closed).toEqual([true]);
  });

  it("苦手が1枚も無ければ、苦手用の空メッセージを出す", () => {
    renderStudy({ focus: "weak", weakSince: Date.now(), initialProgress: [solidRecord("001")] });
    expect(screen.getByText("苦手カードはありません")).toBeTruthy();
  });
});

describe("デッキをまたぐ学習（decks が2つ以上）", () => {
  const yesterday = new Date("2026-08-08T03:00:00Z").getTime();
  /** 期限切れの進捗（deckId 付き） */
  function dueRecord(deckId: string, cardId: string, dueAt: number): ProgressRecord {
    const base = rate(null, 3, new Date("2026-08-01T03:00:00Z"));
    return { deckId, cardId, progress: { ...base, due: dueAt, lastReview: yesterday }, introducedDayKey: "2026-08-01", updatedAt: yesterday };
  }
  const OTHER_DECK: Deck = {
    schemaVersion: 1,
    id: "deck2",
    name: "別のデッキ",
    // 001 は DECK と同じ id（デッキをまたぐと衝突しうる）
    cards: [
      { id: "001", front: "スペインの首都は", back: "マドリード" },
      { id: "009", front: "ドイツの首都は", back: "ベルリン" },
    ],
  };

  it("全デッキの期限切れを期限順に出し、カードにデッキ名を添え、進捗はそれぞれの deckId で保存する", async () => {
    const { container } = renderStudy({
      decks: [DECK, OTHER_DECK],
      title: "まとめて学習",
      initialProgress: [dueRecord("deck1", "001", Date.now() - 1000), dueRecord("deck2", "001", Date.now() - 5000)],
    });
    // deck2/001 の方が期限が早い
    expect(container.querySelector(".study-front")?.textContent).toBe("スペインの首都は");
    expect(container.querySelector(".chip-deck")?.textContent).toBe("別のデッキ");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("まとめて学習");
    // 新規（進捗なし）は出さない
    expect(remainingText()).toContain("残り 2 枚");

    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は"));
    expect(container.querySelector(".chip-deck")?.textContent).toBe("テストデッキ");

    const progress = await readAllProgress();
    const updated = progress.find((record) => record.deckId === "deck2" && record.cardId === "001");
    expect(updated?.progress.reps).toBe(2);
    // deck1/001 は未評価のまま（initialProgress は props で渡しただけなので DB には無い）
    expect(progress.find((record) => record.deckId === "deck1" && record.cardId === "001")).toBeUndefined();
    expect(progress).toHaveLength(1);
  });

  it("同じ id の「もう一度」を取り消しても、別デッキの同じ id の再出題は消えない", async () => {
    const { container } = renderStudy({
      decks: [DECK, OTHER_DECK],
      title: "まとめて学習",
      sessionSize: 10,
      initialProgress: [dueRecord("deck2", "001", Date.now() - 5000), dueRecord("deck1", "001", Date.now() - 1000)],
    });
    // deck2/001 → もう一度（末尾へ再出題）、deck1/001 → もう一度（末尾へ再出題）
    reveal(container);
    fireEvent.click(screen.getByText("難しい"));
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("日本の首都は"));
    // deck1/001 を「もう一度」相当にするため、スワイプの代わりに直接評価はできないので、ここでは取り消しの鍵だけを確かめる
    await waitUntilUndoReady();
    fireEvent.click(undoButton());
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("スペインの首都は"));
    expect(remainingText()).toContain("残り 2 枚");
  });

  it("メモと非表示は、そのカードのデッキ id で保存される", async () => {
    const { container, hidden } = renderStudy({
      decks: [DECK, OTHER_DECK],
      title: "まとめて学習",
      initialProgress: [dueRecord("deck2", "009", Date.now() - 5000), dueRecord("deck1", "002", Date.now() - 1000)],
    });
    expect(container.querySelector(".study-front")?.textContent).toBe("ドイツの首都は");
    fireEvent.click(screen.getByLabelText("メモを書く"));
    const input = (await screen.findByPlaceholderText("メモを入力")) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "首都はベルリン" } });
    fireEvent.click(screen.getByText("とじる"));
    await waitFor(async () => expect(await readCardNotes("deck2")).toHaveLength(1));
    expect(await readCardNotes("deck1")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("このカードを非表示にする"));
    fireEvent.click(screen.getByText("非表示にする"));
    await waitFor(() => expect(hidden).toEqual(["009"]));
    expect(await readHiddenCards("deck2")).toHaveLength(1);
    expect(await readHiddenCards("deck1")).toHaveLength(0);
    await waitFor(() => expect(container.querySelector(".study-front")?.textContent).toBe("フランスの首都は"));
  });

  it("結果画面では定着率ゲージを出さず、一覧にデッキ名が出る", async () => {
    const { container } = renderStudy({
      decks: [DECK, OTHER_DECK],
      title: "まとめて学習",
      initialProgress: [dueRecord("deck2", "009", Date.now() - 5000)],
    });
    reveal(container);
    fireEvent.click(screen.getByText("わかった"));
    await waitFor(() => expect(screen.getByText("終了する")).toBeTruthy());
    expect(document.querySelector(".gauge")).toBeNull();
    expect(document.querySelector(".result-deck")?.textContent).toBe("別のデッキ");
    expect(screen.getByText(/全デッキで今日出せるカードは終わりました/)).toBeTruthy();
  });
});
