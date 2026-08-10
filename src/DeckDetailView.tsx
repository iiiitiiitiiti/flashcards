import { useEffect, useMemo, useRef, useState } from "react";
import { parseCardsCsv } from "./csv";
import type { Deck, DeckCard } from "./deck";
import { deleteImportDraft, deleteProgress, deleteProgressByDeck, readImportDraft, readProgress, saveImportDraft } from "./db";
import { appendCards, upsertCard } from "./deckedit";
import { writeDeck } from "./github";
import { loadToken } from "./storage";
import type { ImportDraft, ProgressRecord } from "./types";

const FSRS_STATE_REVIEW = 2;

interface DeckDetailViewProps {
  deck: Deck;
  onClose: () => void;
  /** GitHub への保存成功後に、保存結果の最新デッキを渡す（App が即時反映する） */
  onDeckUpdated: (deck: Deck) => void;
}

interface EditorState {
  /** null なら新規追加 */
  cardId: string | null;
  front: string;
  back: string;
  note: string;
  tags: string;
}

function parseTags(value: string): string[] | undefined {
  const tags = value
    .split(/[;,、]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return tags.length > 0 ? tags : undefined;
}

export function DeckDetailView({ deck, onClose, onDeckUpdated }: DeckDetailViewProps) {
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importResumed, setImportResumed] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [progressByCard, setProgressByCard] = useState<Map<string, ProgressRecord>>(new Map());
  const canEdit = loadToken() !== "";

  useEffect(() => {
    void readProgress(deck.id).then((records) => {
      setProgressByCard(new Map(records.map((record) => [record.cardId, record])));
    });
  }, [deck.id]);

  useEffect(() => {
    // 前回未完了のインポートがあれば再開を促す（同じ ID で再試行するため重複しない）
    void readImportDraft(deck.id).then((draft) => {
      if (draft) {
        setImportDraft(draft);
        setImportResumed(true);
      }
    });
  }, [deck.id]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const card of deck.cards) {
      for (const tag of card.tags ?? []) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right, "ja"));
  }, [deck]);

  const orderById = useMemo(() => new Map(deck.cards.map((card, index) => [card.id, index + 1])), [deck]);

  const visibleCards = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return deck.cards.filter((card) => {
      if (tagFilter && !(card.tags ?? []).includes(tagFilter)) return false;
      if (keyword === "") return true;
      return [card.front, card.back, card.note ?? ""].some((text) => text.toLowerCase().includes(keyword));
    });
  }, [deck, search, tagFilter]);

  function openEditor(card: DeckCard | null) {
    setMessage(null);
    setEditor(
      card
        ? { cardId: card.id, front: card.front, back: card.back, note: card.note ?? "", tags: (card.tags ?? []).join("; ") }
        : { cardId: null, front: "", back: "", note: "", tags: "" },
    );
  }

  async function handleSave() {
    if (!editor || saving) return;
    if (editor.front.trim() === "" || editor.back.trim() === "") {
      setMessage("表面と裏面は必須です。");
      return;
    }
    setSaving(true);
    setMessage(null);
    const cardId = editor.cardId ?? crypto.randomUUID();
    const card: DeckCard = {
      id: cardId,
      front: editor.front.trim(),
      back: editor.back.trim(),
      ...(editor.note.trim() !== "" ? { note: editor.note.trim() } : {}),
      ...(parseTags(editor.tags) ? { tags: parseTags(editor.tags) } : {}),
    };
    try {
      const next = await writeDeck(
        deck.id,
        loadToken(),
        `deck(${deck.id}): ${editor.cardId ? `edit card ${cardId}` : "add card"}`,
        (latest) => upsertCard(latest, card),
      );
      setEditor(null);
      setMessage(editor.cardId ? "カードを更新しました。" : "カードを追加しました。");
      onDeckUpdated(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  async function handleCsvFile(file: File) {
    setMessage(null);
    setImportWarnings([]);
    try {
      const parsed = parseCardsCsv(await file.text());
      // 取り込む全カードの ID をこの時点で確定し、draft として永続化する。
      // PUT 成功後に応答だけ失われても、同じ ID での再試行が重複追加にならない
      const draft: ImportDraft = {
        draftId: crypto.randomUUID(),
        deckId: deck.id,
        cards: parsed.rows.map((row) => ({ id: crypto.randomUUID(), ...row })),
        createdAt: Date.now(),
      };
      await saveImportDraft(draft);
      setImportDraft(draft);
      setImportResumed(false);
      setImportWarnings(parsed.warnings);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CSV の読み込みに失敗しました。");
    }
  }

  async function handleConfirmImport() {
    if (!importDraft || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const next = await writeDeck(
        deck.id,
        loadToken(),
        `deck(${deck.id}): import ${importDraft.cards.length} cards from CSV`,
        (latest) => appendCards(latest, importDraft.cards).deck,
      );
      await deleteImportDraft(importDraft.draftId);
      setMessage(`${importDraft.cards.length} 件のカードを取り込みました。`);
      setImportDraft(null);
      setImportWarnings([]);
      onDeckUpdated(next);
    } catch (error) {
      setMessage(
        `${error instanceof Error ? error.message : "インポートに失敗しました。"} 取り込み内容は保存されているので、後で再試行できます。`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelImport() {
    if (!importDraft) return;
    await deleteImportDraft(importDraft.draftId);
    setImportDraft(null);
    setImportWarnings([]);
  }

  async function handleResetDeckProgress() {
    if (!window.confirm(`「${deck.name}」の学習進捗をすべてリセットしますか？ 全カードが新規に戻ります（カード自体は消えません）。`)) return;
    const deleted = await deleteProgressByDeck(deck.id);
    setProgressByCard(new Map());
    setMessage(`${deleted} 件の学習進捗をリセットしました。`);
  }

  async function handleResetProgress() {
    if (!editor?.cardId) return;
    if (!window.confirm("このカードの学習進捗をリセットしますか？（新規カードに戻ります）")) return;
    await deleteProgress(deck.id, editor.cardId);
    setMessage("進捗をリセットしました。");
  }

  return (
    <section>
      <header className="app-header">
        <h1>{deck.name}</h1>
        <button type="button" onClick={onClose}>戻る</button>
      </header>
      <p className="muted">全 {deck.cards.length} 枚{canEdit ? "" : "（閲覧のみ。編集にはトークン設定が必要）"}</p>
      {message && <p className="notice">{message}</p>}

      {editor ? (
        <div className="settings-group">
          <h2>{editor.cardId ? "カードを編集" : "カードを追加"}</h2>
          <label>
            表面（問題）
            <textarea value={editor.front} rows={3} onChange={(event) => setEditor({ ...editor, front: event.target.value })} />
          </label>
          <label>
            裏面（答え）
            <textarea value={editor.back} rows={3} onChange={(event) => setEditor({ ...editor, back: event.target.value })} />
          </label>
          <label>
            補足メモ（任意）
            <textarea value={editor.note} rows={2} onChange={(event) => setEditor({ ...editor, note: event.target.value })} />
          </label>
          <label>
            タグ（; 区切り・任意）
            <input type="text" value={editor.tags} onChange={(event) => setEditor({ ...editor, tags: event.target.value })} />
          </label>
          <div className="button-row">
            <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
              {saving ? "保存中…" : "GitHubへ保存"}
            </button>
            <button type="button" disabled={saving} onClick={() => setEditor(null)}>キャンセル</button>
            {editor.cardId && (
              <button type="button" disabled={saving} onClick={() => void handleResetProgress()}>進捗リセット</button>
            )}
          </div>
        </div>
      ) : (
        <div className="deck-toolbar">
          <input type="text" value={search} placeholder="検索" onChange={(event) => setSearch(event.target.value)} />
          {allTags.length > 0 && (
            <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
              <option value="">全タグ</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          )}
          {canEdit && (
            <>
              <button type="button" className="primary" onClick={() => openEditor(null)}>カード追加</button>
              <button type="button" onClick={() => csvInputRef.current?.click()}>CSV取込</button>
              <input
                ref={csvInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden-input"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleCsvFile(file);
                  event.target.value = "";
                }}
              />
            </>
          )}
        </div>
      )}

      {importDraft && (
        <div className="settings-group">
          <h2>CSVインポートの確認</h2>
          {importResumed && <p className="notice warning">前回のインポートが未完了です。再試行するか破棄してください。</p>}
          <p>
            {importDraft.cards.length} 件のカードを「{deck.name}」へ追加します。
          </p>
          {importWarnings.map((warning) => (
            <p key={warning} className="notice warning">{warning}</p>
          ))}
          <ul className="import-preview muted">
            {importDraft.cards.slice(0, 5).map((card) => (
              <li key={card.id}>{card.front} → {card.back}</li>
            ))}
            {importDraft.cards.length > 5 && <li>…ほか {importDraft.cards.length - 5} 件</li>}
          </ul>
          <div className="button-row">
            <button type="button" className="primary" disabled={saving} onClick={() => void handleConfirmImport()}>
              {saving ? "取込中…" : "GitHubへ取り込む"}
            </button>
            <button type="button" disabled={saving} onClick={() => void handleCancelImport()}>破棄</button>
          </div>
        </div>
      )}

      <ul className="card-list">
        {visibleCards.map((card) => {
          const record = progressByCard.get(card.id);
          const phase = record?.progress.reps ?? 0;
          const stable = record?.progress.state === FSRS_STATE_REVIEW;
          return (
            <li key={card.id} className="card-row">
              <button
                type="button"
                className="card-row-button"
                onClick={() => (canEdit ? openEditor(card) : undefined)}
                disabled={!canEdit}
              >
                <span className="card-row-meta">
                  <span className="card-index">{orderById.get(card.id)}</span>
                  {phase > 0 && (
                    <span className={`phase-chip${stable ? " phase-chip--stable" : ""}`}>フェーズ {phase}</span>
                  )}
                </span>
                <span className="card-front"><span className="qa-mark qa-q">Q</span>{card.front}</span>
                <span className="card-back"><span className="qa-mark qa-a">A</span>{card.back}</span>
                {card.tags && card.tags.length > 0 && (
                  <span className="card-tags">
                    {card.tags.map((tag) => (
                      <span key={tag} className="tag-chip">{tag}</span>
                    ))}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {visibleCards.length === 0 && <li className="muted">該当するカードがありません。</li>}
      </ul>
      <div className="deck-footer">
        <button type="button" onClick={() => void handleResetDeckProgress()}>このデッキの学習進捗をリセット</button>
        <p className="muted">この端末の学習記録だけを消します。カードは消えません。</p>
      </div>
    </section>
  );
}
