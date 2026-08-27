import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// iOS Safari は viewport の user-scalable=no を無視するので、ピンチ操作そのものを止める
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

/*
 * 押下表現（styles.css の button:active）を iOS でも出すための補助。
 * **iOS Safari はタップで :active を当てない**ので、タップハイライトを消しただけだと
 * iPhone では押した手応えが完全に消えてしまう。pointer イベントで data-pressed を付け外しし、
 * CSS 側で :active と同じ見た目を当てる。マウス環境では :active だけでも成立する。
 */
let pressedElement: Element | null = null;

function releasePressedElement() {
  pressedElement?.removeAttribute("data-pressed");
  pressedElement = null;
}

document.addEventListener(
  "pointerdown",
  (event) => {
    // ハイライトを全要素で消しているので、押せるものはすべて拾う（非表示一覧の summary を含む）
    const target = event.target instanceof Element ? event.target.closest("button, summary") : null;
    releasePressedElement();
    // 無効なボタンは沈ませない（CSS の :not(:disabled) と揃える）
    if (!target || (target instanceof HTMLButtonElement && target.disabled)) return;
    pressedElement = target;
    target.setAttribute("data-pressed", "");
  },
  { passive: true },
);

// 離す・スクロールで取り消される・長押しメニューが出る、のいずれでも戻す（押しっぱなしに見せない）。
// pointerout は子要素（アイコンの svg）へ移るだけでも飛ぶので使わない
for (const type of ["pointerup", "pointercancel", "pointerleave", "contextmenu"]) {
  document.addEventListener(type, releasePressedElement, { passive: true });
}
window.addEventListener("blur", releasePressedElement);

const root = document.getElementById("root");
if (!root) throw new Error("#root が見つかりません");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
