/**
 * 学習中にカードそのものを直すダイアログ。
 *
 * カード一覧（`DeckDetailView`）の編集フォームと同じ項目を、`<dialog showModal>` で出す。
 * 入力欄があるので、メモと同じく**画面上部**へ置く（下にあると iOS が画面ごと持ち上げる。
 * `docs/decisions/005` 参照）。
 *
 * **カード id は変えない。** 学習進捗のキーなので、変えると進捗が孤児になる。
 */
import { useEffect, useRef, useState } from "react";
import type { DeckCard } from "./deck";
import { validateCardForm, type CardForm } from "./deckedit";
import { useVisibleViewport } from "./viewport";

interface CardEditorProps {
  card: DeckCard;
  /** 保存する。成功したら true。false なら理由を `message` で出したままにする */
  onSave: (form: CardForm) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
}

export function CardEditor({ card, onSave, onCancel }: CardEditorProps) {
  const [form, setForm] = useState<CardForm>({
    front: card.front,
    back: card.back,
    note: card.note ?? "",
    tags: (card.tags ?? []).join("; "),
  });
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
    const invalid = validateCardForm(form);
    if (invalid) {
      setMessage(invalid);
      return;
    }
    setSaving(true);
    setMessage(null);
    const result = await onSave(form);
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
        <label>
          タグ（; 区切り・任意）
          <input type="text" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
        </label>
        {message && <p className="notice warning">{message}</p>}
        <div className="sheet-actions">
          <button type="button" className="primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "保存中…" : "GitHubへ保存"}
          </button>
          <button type="button" disabled={saving} onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </dialog>
  );
}
