## 010. 学習進捗は private リポへ gzip で自動バックアップし、復元は履歴から版を選べるようにする

- 日付: 2026-09-04
- 対象: `src/cloudbackup.ts`（新規）、`src/github.ts`（`readRepoFile` / `statRepoFile` / `putRepoFile` / `listFileCommits`、`testConnection` の repository 引数）。
  ほかに `src/backup.ts`（1トランザクション化・`gzipBlob` / `parseBackupBytes`）、`src/storage.ts`（4キー）、`src/App.tsx`（学習終了後の自動送信）、`src/SettingsView.tsx`

### 背景

学習進捗（cardProgress / reviewLog / cardNotes / hiddenCards）は iPhone の IndexedDB にしか無く、端末が壊れると3万問分の記録が消える。
手動の JSON 書き出しはあったが、忘れると意味がない。ユーザーは「新規の private リポへ保存・学習終了時に1日1回」を選んだ。

### 決定

1. 保存先は **`iiiitiiitiiti/flashcards-progress`（private）** の `backups/latest.json.gz` 1本を上書きする。過去版は git 履歴が持つ。
   デッキ用の fine-grained PAT にこのリポも追加してもらう（Contents: Read and write）
2. 中身は手動書き出しと同じ JSON を **gzip** したもの。素の JSON は全カード学習時に 12MB 級（進捗 9MB + ログ上限 20,000 件 3MB）になり、
   base64 化のピークメモリ・PUT 上限・リポ肥大が同時に問題になる（Opus レビュー指摘）。CompressionStream は iOS 16.4 以降
3. 取り込み口は1つ（`parseBackupBytes`）。gzip の魔法数（1f 8b）で見分け、GitHub から手で落とした `.json.gz` も従来の `.json` も「JSONを取り込む」で読める
4. **自動送信は学習を終えてホームへ戻った2秒後**。前回成功から 24 時間以上、かつ前回試行から 6 時間以上（失敗の連打を抑える）なら送る。
   開始時点でホームでなければ送らない。試行時刻は localStorage とメモリの両方に持ち、localStorage が書けない環境でも同じセッションでは繰り返さない。
   記録が未来（時計を戻した）なら未実施として扱う
5. 失敗は無視しない。ホームに1行（「GitHub への進捗バックアップに失敗しました: …」）、設定に理由と時刻を残す。成功時は何も出さない
6. `exportBackup` は4ストアを**1つの readonly トランザクション**で読む。別々に読むと、途中で入った評価が「ログにはあるが進捗は古い」形で残る
7. 復元は `importBackup` の**マージ**（上書きではない）。設定に「端末側が新しい進捗は残る・消した進捗が戻ることがある・非表示の解除は戻らない」と明記。
   最新が壊れていたときの逃げ道として、`commits?path=` で直近 10 版を出す。`contents?ref=<sha>` → Blob API で任意の版を取れる
8. 上書き PUT の sha は `statRepoFile`（Contents API の GET）で取る。1MB 超のファイルは本文が返らないので、数MB を読み戻さずに済む。
   409（競合）と 422（sha の食い違い）は sha を取り直して最大3回。手動と自動の同時実行は `writeDeck` と同じキューで直列化
9. 接続テストはバックアップ用リポについて **「届くか」だけ**を出す（`GET /repos/...` の 200 / 404）。`permissions.push` が fine-grained PAT の
   Contents 権限を映す保証が無いので、書き込みは「今すぐ GitHub へ保存」で確かめる。404 は「PAT のリポジトリ一覧に追加」、403 は「Contents を Read and write に」と直し方を書く

### 比較した代替案

- 却下: flashcards リポ（public）の別ブランチに置く — PAT 変更が不要だが、学習履歴とカードのメモが公開される。ユーザーが private を選択
- 却下: 素の JSON で送る（v1 案） — 復元の形式が手動書き出しと揃う利点はあるが、10MB 級の base64 を iPhone で組み立てることになる。
  Contents API の PUT は 5MB で成功を確認したが、それ以上は未確認。gzip なら 1〜2MB 級に収まり、`parseBackupBytes` で形式の違いも吸収できる
- 却下: 端末 id ごとのファイル — 端末は1台。復元で「どのファイルか」を選ぶ UI が要る。版選択の復元があれば、2端末が上書きし合っても履歴から戻せる
- 却下: `previous.json` を1世代だけ持つ — 旧本文を読み戻してもう1回 PUT する（転送が倍）。履歴からの版選択の方が安く、何世代でも戻れる
- 却下: 自動送信の既定を無効にし、接続テスト成功で有効化を促す — PAT を直すまで 6 時間おきに1行出るだけなので、既定有効で「気づける」方を取った
- 却下: Git Data API で送る — 読みも書きも Contents API で足りる（`009` と同じ判断）
- 採用: 上記の決定

### 影響範囲

- 新規 private リポ `flashcards-progress`（README のみ。アプリが `backups/latest.json.gz` を作る）
- ユーザー作業: PAT のリポジトリ一覧に `flashcards-progress` を追加（Contents: Read and write）。追加するまで自動送信は 6 時間おきに失敗を1行出す
- 設定画面の「JSONを取り込む」が `.gz` も受け付ける。`FlashcardsDB` 型を export した（`backup.ts` のトランザクション型に使う）

### 検証

- `tests/cloud-backup.test.ts`（21 件）。送信側: 初回は sha 無し PUT で本文が gzip／2回目は GET の sha を付け Blob API は呼ばない／409・422 で sha を取り直す／404・403 の文言／同時実行の直列化。
  復元側: gzip と素の JSON の両方を読む／マージで端末側が新しい進捗は残る／1MB 超は Blob API・ref 指定で過去版／壊れた版は取り込まない。
  判定: `shouldAutoBackup` の境界（24h・6h・時計戻し）
- `tests/storage.test.ts`: 自動バックアップ既定 on、成功時刻・試行時刻・失敗の別管理
- 実 API（2026-09-04、gh CLI）: 空リポへの README PUT で初期コミットができる／5MB の PUT が 3.8 秒で成功／>1MB の GET は `encoding: "none"`／
  `commits?path=` と `contents?ref=<sha>` で過去版を取れる。プローブファイルは削除済み
- preview + Chrome: 設定画面に節が出る。ダミートークンで「今すぐ保存」「接続テスト」→ 401 の文言。実 PAT での送信・復元は iPhone で確認する（Mac 側の引き継ぎ）
- 半年後にこの判断が間違いだったと分かる兆候: リポサイズが数百 MB を超える（gzip でも毎日1コミット）、PC ブラウザでも学習を始めて
  `latest.json.gz` を2端末で上書きし合っている（→ 端末 id ごとのファイルへ）、3万件の `importBackup` が iOS で完走しない
