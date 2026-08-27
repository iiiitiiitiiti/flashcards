# 003. タップ時の OS 既定ハイライトを消し、「軽く沈む」押下表現へ置き換える

- 日付: 2026-08-27
- 対象: `src/styles.css`（全 `button` 共通。下ナビ・ヘッダーの○←・評価ボタン・カレンダーのマスなど）

### 背景

下ナビやボタンをタップすると一瞬黒くなる、という指摘があった。調べると CSS で当てている見た目ではなく、
**iOS Safari / Chrome が既定で持つタップハイライト**（`-webkit-tap-highlight-color`）だった。
`styles.css` には当時この指定も `:active` の指定も無く、既定値のまま出ていた。
ホバーは無関係で、`:hover` のルールは1つも無い。

### 決定

`*` に `-webkit-tap-highlight-color: transparent` を当てて既定のハイライトを消し、
代わりに `scale(0.96)` と `opacity: 0.72` を 0.12s で当てる。
アプリ内設定の `data-motion="crossfade"`（動きを減らす）では `transform: none` にして、薄くなるだけにする。

押した見た目は `:hover` ではなく **`:active` で作る**。iOS では `:hover` を付けるとタップ後に状態が居座るため。

**ただし `:active` だけでは iOS で成立しない**（2026-08-27 追記。初版はこれを見落として一度デプロイした）。
iOS Safari はタップで `:active` を当てないため、ハイライトを消しただけでは **iPhone で押した手応えが完全に消える**。
主な利用環境がまさに iPhone なので、`main.tsx` で `pointerdown` を拾って押した要素へ `data-pressed` を付け、
CSS は `button:active` と `button[data-pressed]` の両方に同じ見た目を当てる。
解除は `pointerup` / `pointercancel` / `pointerleave` / `contextmenu` / `window.blur`。
`pointerout` は**使わない**（アイコンの `svg` へ移っただけで飛ぶので、押している最中に解除されてしまう）。

対象は `button` と `<summary>`。`*` でハイライトを消す以上、**押せるものすべてに代わりの表現を用意する**。
`<summary>` は幅いっぱいなので縮小せず、薄くするだけにする。

### 比較した代替案

- 却下: **薄い背景色を敷く**（`.nav-tab:active { background: rgba(...) }` ＋ `filter: brightness()`）
  — 面で押すものとの相性はよいが、ユーザーが「軽く沈む」を選んだ。色を足すぶんテーマの色数が増える
- 却下: **ハイライトを消すだけで押下表現を付けない** — 最も静かだが、タップが効いたか分からなくなる
- 却下: **`:active` だけで済ませる**（初版）— iOS では発火しないため、iPhone で手応えがゼロになる
- 却下: **`document` に空の `touchstart` リスナーを足す**（`:active` を効かせる古典的な回避策）— 差分は小さいが、効くかどうかが端末・OS 版に依存する。押下の開始と解除を自分で持つ方が確実で、条件も読める
- 却下: **`-webkit-tap-highlight-color` の適用を `button` だけに絞る**（Codex 案）— `<summary>` は黒い明滅が残ったままになる。ユーザーの指摘は「タップすると一瞬暗くなる」全般なので、狭めるのではなく `<summary>` にも代わりの表現を足す方を採った
- 採用: **軽く沈む**（縮小＋減光）＋ `pointerdown` 由来の `data-pressed`

### 影響範囲

- `button` 要素すべて。`.flip-scene`（カード本体）は `<div>` なので、めくり・スワイプのアニメーションには影響しない
- `button` に `transform` を持つルールは他に無い（追加するときは `:active` の縮小と衝突しないか確認する）
- `:root[data-motion="crossfade"]` の上書きは**同じ詳細度**なので、必ず基本ルールより後ろに置くこと

### 検証

preview（:4173）＋ Playwright 390×844、SW を unregister してから測定。

- `.nav-tab` / `body` の `webkitTapHighlightColor` が `rgba(0, 0, 0, 0)`
- 押下中 `matrix(0.96, 0, 0, 0.96, 0, 0)` / `opacity 0.72` → 離すと `none` / `1`
- 無効ボタン（統計の「次の月」）は押下中も `transform: none`、`opacity` は 0.5 のまま
- `data-motion="crossfade"` では押下中も `transform: none`、`opacity` は 0.72
- **合成 `PointerEvent` で `pointerdown` を送ると（`:active` は立たないので iOS の状況の代役になる）、`data-pressed` だけで `matrix(0.96, …)` / `opacity 0.72` になる**
- 子の `svg` を押しても親のボタンが沈み、その `svg` への `pointerout` では解除されない
- 無効ボタンには `data-pressed` が付かない。操作後に取り残しは 0 件
- page error は 0 件（CSP の `frame-ancestors` 警告のみで、変更前から出ている）

**iPhone 実機で確認済み**（2026-08-27、ユーザー実施）。押下のアニメーションが出ることを確認した。
Playwright は Chromium なので、iOS の `:active` 挙動そのものは harness 側では再現できない。
**この種の確認は今後も実機へ回す**（デスクトップのマウス操作で「確認済み」と書くと、主端末で壊れているものを通す）。

判断が間違いだったとわかる条件: 実機で押下が分かりにくい、押しっぱなしに見える、または縮小が他の transform と衝突して表示が崩れる。

### 関連ファイル

- `src/styles.css`
- `src/main.tsx`
