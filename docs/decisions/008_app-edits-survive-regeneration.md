## 008. アプリ側の編集は JSON の 3-way マージで残し、xlsx への反映は任意の後段にする

- 日付: 2026-09-04
- 対象: `scripts/merge-decks.mjs`（新規）、`scripts/sync-decks.mjs`（マージ段）、`scripts/quizxlsx.py`・`scripts/writeback-quiz-xlsx.py`（新規）、
  `src/TagPicker.tsx`（新規）、`src/deckedit.ts`、`src/CardEditor.tsx`、`src/DeckDetailView.tsx`、`src/StudyView.tsx`、`src/App.tsx`、
  `src/db.ts`（`moveCardLocalData`）、`src/github.ts`（`moveCardBetweenDecks`）

### 背景

`quiz-*` デッキは クイズ.xlsx から機械生成する。アプリ（iPhone）でカードを直すと GitHub の `decks/*.json` には入るが、
次の再生成で消える。2026-09-04 に実際、アプリで直したカード 00367 の問題文が再生成で消えるところだった（手で xlsx へ移して回避）。

要望は2つ。(1) カードを別デッキへ移せること（ジャンル誤りを iPhone で直したい）、(2) タグを自由入力ではなく既存タグから選ぶこと
（似た綴りのタグが増えるのを防ぐ）。どちらも「アプリで直した内容が再生成で消えない」ことが前提になる。

### 決定

1. **再生成のたびに 3-way マージする。** base = 前回の再生成コミット（件名「chore: クイズ.xlsx からデッキを再生成」で探す）の `decks/`、
   ours = HEAD、theirs = xlsx から生成した結果。base→ours の差分が「アプリでやったこと」。theirs のそのカードが base のままなら ours を当て、
   既に ours と同じなら何もしない（xlsx へ反映済み）、どちらとも違えば衝突。衝突は既定で止めて一覧を出し、`--on-conflict=xlsx|app` で続行できる
2. タグは**集合**として比較する（TagPicker は末尾に足す・importer は決まった順に並べる。順序で差分が出ると相殺できない）
3. **xlsx への反映は任意の後段**（`--writeback`。xlwings と Excel が要る）。付けなくてもマージ結果は残り、書き戻すべき変更は
   `writeback-pending.json` に出る。3値判定なので、あとから xlsx を直せば次回は no-op になる
4. `quiz-sonota` はマージ対象外（大ジャンル名がタグに入る特殊形で、列へ戻せない）。アプリで追加したカード（xlsx に行が無い）はアプリ側のデッキに残し、一覧に出す
5. アプリ側: 生成デッキでは**新規タグを作らせず**、保存時に「小ジャンル系ちょうど1つ・★は1つまで」を検証する（xlsx の列へ分解できない形を iPhone の時点で止める）
6. デッキ移動は**同じ群**（生成デッキ同士・手書きデッキ同士）に限る。GitHub は「先に移動先へ追加 → 元から削除」。端末側の進捗・ログ・メモ・非表示は
   `moveCardLocalData` で移し、移動先に同じ鍵の進捗があれば拒否する
7. 1MB 超の3デッキ（公民・理系・生活）は Contents API で書けないので、移動元・先の候補から外す（別途 Git Data API 化で解消できる。未着手）

### 比較した代替案

- 却下: xlsx への書き戻しを主経路にする（v1 案） — 書き戻しと base の前進が原子的でなく、push が落ちると次回は必ず「xlsx 側も変わった」と誤検出して止まる。
  Excel の無い環境では何もできない。レビュー（Opus）の指摘で JSON マージへ切り替えた
- 却下: アプリだけで移動・タグ選択を作り、xlsx には戻さない — 次の再生成で消える。今日の事故が再発する
- 却下: `quiz-*` の編集をアプリで禁止し xlsx 運用に寄せる — 最も安全だが iPhone で直せなくなる。要望に反する
- 却下: 群をまたぐ移動（quiz-* ⇔ 手書き）を許す — sync から見て「xlsx の行が消えた／増えた」になり止まる。xlsx の行削除を設計しない限り不可
- 却下: 小ジャンルの体系を `quiz_io.py genres` で検証する — `~/.claude` のスキルに依存し環境で結果が変わる。候補が「そのデッキの既存タグ」なら定義上その大ジャンル配下なので不要
- 却下: 大ジャンル→デッキの対応表を JSON に切り出す — 正本の二重化。逆引きは python 側で importer の表を import して済ませた
- 却下: base を `decks/.sync-base` ファイルで持つ — コミット sha を書くにはコミット後に amend が要る。件名で探す方式は、コミットが出来ていれば base も進むので十分
- 採用: 上記の決定

### 影響範囲

- `npm run decks:sync` は 5 段になり、アプリ側の変更を消さない。`--on-conflict` / `--writeback` が増えた
- `decks/README.md` の「手で編集しない」は「アプリからの編集は再生成で残る。xlsx へは `--writeback` か手で反映」に変わる
- `CardForm.tags` は配列。カード追加・編集・学習中の編集の3経路が TagPicker を使う
- `onDeckUpdated` は複数デッキを受ける（移動で2デッキ同時に差し替える。1デッキずつ古い snapshot を元に差し替えると後の更新が前を打ち消す）

### 検証

- `tests/merge-decks.test.ts`: 編集・移動・追加・削除の分類、3値判定（適用 / no-op / 衝突）、`--on-conflict=app`、除外デッキ
- `tests/db-move.test.ts`: 進捗・ログ・メモ・非表示の移送、移動先に既存があれば失敗して何も変えない
- `tests/github-move.test.ts`: 先に移動先へ PUT、次に元へ PUT。同じデッキは拒否
- `tests/tag-picker.test.tsx`・`tests/study-view.test.tsx`: 候補の付け外し、新規タグは明示ボタンのみ、移動でキューから抜けて2デッキが親へ渡る
- 実データ: 直した直後の xlsx で `decks:sync --dry-run` → 「アプリ側の変更 0 件」「変更はありません」。
  合成した pending JSON で `writeback-quiz-xlsx.py --dry-run` → 通常の編集と移動は書き戻し対象、xlsx 側が変わっている行・分解できないタグ・アプリ追加は飛ばして一覧に出た
- 半年後にこの判断が間違いだったと分かる兆候: 衝突が頻発して `--on-conflict` を毎回付けている（＝両側で同じカードを直す運用になっている）、
  `writeback-pending.json` が溜まり続けている（＝xlsx への反映が回っていない）
