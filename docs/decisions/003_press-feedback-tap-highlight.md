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
代わりに `button:active:not(:disabled)` で `scale(0.96)` と `opacity: 0.72` を 0.12s で当てる。
アプリ内設定の `data-motion="crossfade"`（動きを減らす）では `transform: none` にして、薄くなるだけにする。

押した見た目は `:hover` ではなく **`:active` で作る**。iOS では `:hover` を付けるとタップ後に状態が居座るため。

### 比較した代替案

- 却下: **薄い背景色を敷く**（`.nav-tab:active { background: rgba(...) }` ＋ `filter: brightness()`）
  — 面で押すものとの相性はよいが、ユーザーが「軽く沈む」を選んだ。色を足すぶんテーマの色数が増える
- 却下: **ハイライトを消すだけで押下表現を付けない** — 最も静かだが、タップが効いたか分からなくなる
- 採用: **軽く沈む**（縮小＋減光）— 色を足さずに反応を返せる

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
- page error は 0 件（CSP の `frame-ancestors` 警告のみで、変更前から出ている）

判断が間違いだったとわかる条件: 実機で押下が分かりにくい、または縮小が他の transform と衝突して表示が崩れる。

### 関連ファイル

- `src/styles.css`
