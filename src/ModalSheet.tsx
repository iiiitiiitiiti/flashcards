/**
 * 画面上部に出すモーダルの器。`<dialog showModal>` なので上位レイヤーへ載り、
 * 親の overflow や z-index の影響を受けない。
 *
 * **入力欄を持つシートはこれを使う。** 画面下部に入力欄があると、iOS Safari は
 * キーボードに隠れないよう画面全体を持ち上げてしまう（`docs/decisions/005`）。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useVisibleViewport } from "./viewport";

interface ModalSheetProps {
  /** スクリーンリーダー向けの名前 */
  label: string;
  /** Esc で閉じようとしたとき。閉じさせたくない間（保存中など）は渡さない */
  onCancel?: () => void;
  children: ReactNode;
}

export function ModalSheet({ label, onCancel, children }: ModalSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewport = useVisibleViewport(true);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    // jsdom は showModal を持たないので open 属性で代用する（CardEditor と同じ）
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="modal form-dialog"
      aria-label={label}
      style={
        {
          "--viewport-top": `${viewport.top}px`,
          ...(viewport.height === null ? {} : { "--viewport-height": `${viewport.height}px` }),
        } as React.CSSProperties
      }
      onCancel={(event) => {
        event.preventDefault();
        onCancel?.();
      }}
    >
      <div className="sheet">{children}</div>
    </dialog>
  );
}
