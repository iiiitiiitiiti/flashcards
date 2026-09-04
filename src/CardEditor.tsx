/**
 * 学習中にカードそのものを直すダイアログ。
 *
 * カード一覧（`DeckDetailView`）の編集フォームと同じ項目を、`<dialog showModal>` で出す。
 * 入力欄があるので、メモと同じく**画面上部**へ置く（下にあると iOS が画面ごと持ち上げる。
 * `docs/decisions/005` 参照）。
 *
 * **カード id は変えない。** 学習進捗のキーなので、変えると進捗が孤児になる。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Deck, DeckCard } from "./deck";
import { collectDeckTags, isGeneratedDeck, tagsForMove, validateCardForm, validateGeneratedTags, type CardForm } from "./deckedit";
import { TagPicker } from "./TagPicker";
import { useVisibleViewport } from "./viewport";

interface CardEditorProps {
  /** カードが属するデッキ。タグの候補と、新規タグを許すかの判定に使う */
  deck: Deck;
  card: DeckCard;
  /** 移動先にできるデッキ（`moveTargets`）。空なら「デッキ」の選択肢を出さない */
  moveTargets: Deck[];
  /** 保存する。targetDeckId が deck.id と違えば移動。成功したら true。false なら理由を `message` で出したままにする */
  onSave: (form: CardForm, targetDeckId: string) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
}

export function CardEditor({ deck, card, moveTargets, onSave, onCancel }: CardEditorProps) {
  const [form, setForm] = useState<CardForm>({
    front: card.front,
    back: card.back,
    note: card.note ?? "",
    tags: card.tags ?? [],
  });
  const [targetDeckId, setTargetDeckId] = useState(deck.id);
  const targetDeck = moveTargets.find((candidate) => candidate.id === targetDeckId) ?? deck;
  const tagOptions = useMemo(() => collectDeckTags(targetDeck), [targetDeck]);

  /** 移動先を変えると、小ジャンル系のタグは移動先の体系から選び直す（元に戻せば元のタグに戻る） */
  function changeTarget(nextId: string) {
    setTargetDeckId(nextId);
    setMessage(null);
    setForm((current) => ({ ...current, tags: nextId === deck.id ? (card.tags ?? []) : tagsForMove(current.tags, isGeneratedDeck(deck)) }));
  }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewport = useVisibleViewport(true);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    // jsdom は showModal を持たないので open 属性で代用する（メモと同じ）
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
  }, []);

  async function handleSave() {
    if (saving) return;
    const invalid = validateCardForm(form) ?? (isGeneratedDeck(targetDeck) ? validateGeneratedTags(form.tags) : null);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setSaving(true);
    setMessage(null);
    const result = await onSave(form, targetDeckId);
    if (!result.ok) {
      setMessage(result.message ?? "保存に失敗しました。");
      setSaving(false);
    }
    // 成功したら親がこのダイアログを閉じる（setState は走らせない）
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal card-edit-dialog"
      aria-label="カードを編集"
      style={
        {
          "--viewport-top": `${viewport.top}px`,
          ...(viewport.height === null ? {} : { "--viewport-height": `${viewport.height}px` }),
        } as React.CSSProperties
      }
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
    >
      <div className="sheet">
        <h2>カードを編集</h2>
        <label>
          表面（問題）
          <textarea
            value={form.front}
            rows={3}
            autoFocus
            onChange={(event) => setForm({ ...form, front: event.target.value })}
          />
        </label>
        <label>
          裏面（答え）
          <textarea value={form.back} rows={2} onChange={(event) => setForm({ ...form, back: event.target.value })} />
        </label>
        <label>
          補足メモ（任意）
          <textarea value={form.note} rows={2} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </label>
        {moveTargets.length > 0 && (
          <label>
            デッキ
            <select value={targetDeckId} disabled={saving} onChange={(event) => changeTarget(event.target.value)}>
              <option value={deck.id}>{deck.name}（今のデッキ）</option>
              {moveTargets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            {targetDeckId !== deck.id && <span className="field-hint">学習進捗・メモも一緒に移します。移動先のタグを選んでください。</span>}
          </label>
        )}
        <div className="field">
          <span className="sheet-label">タグ（任意）</span>
          <TagPicker
            value={form.tags}
            options={tagOptions}
            allowNew={!isGeneratedDeck(deck)}
            disabled={saving}
            onChange={(tags) => setForm({ ...form, tags })}
          />
        </div>
        {message && <p className="notice warning">{message}</p>}
        <div className="sheet-actions">
          <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "保存中…" : targetDeckId !== deck.id ? "移動してGitHubへ保存" : "GitHubへ保存"}
          </button>
          <button type="button" disabled={saving} onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </dialog>
  );
}
