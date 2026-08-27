/**
 * ソフトキーボードが出ている間に「実際に見えている領域」を追う。
 *
 * iOS Safari はキーボードが出ても**レイアウトの高さを変えない**。代わりに、入力欄が隠れるなら
 * 画面全体をスクロールして持ち上げる。`position: fixed` のダイアログもまとめて動くので、
 * 背景の学習画面ごと上へずれてしまう。
 *
 * `visualViewport` の高さと位置をダイアログへ当てれば、入力欄は最初から見える位置に入る。
 * 持ち上げる理由が無くなるので、画面は動かない。
 */
import { useEffect, useState } from "react";

export interface VisibleViewport {
  /** レイアウト上端からの、見えている領域の上端 */
  top: number;
  /** 見えている領域の高さ。取得できない環境では null（その場合は CSS 既定の全画面に任せる） */
  height: number | null;
}

const FULL: VisibleViewport = { top: 0, height: null };

export function useVisibleViewport(active: boolean): VisibleViewport {
  const [viewport, setViewport] = useState<VisibleViewport>(FULL);

  useEffect(() => {
    const visual = window.visualViewport;
    if (!active || !visual) {
      setViewport(FULL);
      return;
    }
    function apply() {
      const target = window.visualViewport;
      if (!target) return;
      setViewport({ top: target.offsetTop, height: target.height });
      // iOS が既に持ち上げていたら戻す。ダイアログ側で見える位置に入れるので、ずらす必要はない
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    }
    apply();
    visual.addEventListener("resize", apply);
    visual.addEventListener("scroll", apply);
    return () => {
      visual.removeEventListener("resize", apply);
      visual.removeEventListener("scroll", apply);
    };
  }, [active]);

  return active ? viewport : FULL;
}

/** ダイアログの背景に当てるスタイル。高さが取れないときは CSS の `inset: 0` に任せる */
export function viewportStyle(viewport: VisibleViewport): React.CSSProperties | undefined {
  if (viewport.height === null) return undefined;
  return { top: viewport.top, height: viewport.height, bottom: "auto" };
}
