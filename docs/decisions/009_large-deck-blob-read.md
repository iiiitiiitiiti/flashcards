## 009. 1MB 超のデッキは、書き込み経路を替えずに「読みだけ Blob API」で対応する

- 日付: 2026-09-04
- 対象: `src/github.ts`（`getDeckContents` / `fetchBlob`）、`src/deckedit.ts`（`MAX_WRITABLE_DECK_BYTES`）

### 背景

公民・理系・生活の3デッキは JSON が 1MB を超え、アプリからカードの追加・編集・移動ができなかった。
原因は Contents API の GET が 1MB 超のファイルで本文を返さないこと（`encoding: "none"`・`content: ""`。sha は返る）。
`writeDeck` は「最新本文を取る → 変更を当てる → sha 付きで PUT」なので、本文が取れない時点で止まっていた。

### 決定

- 本文が返らなかったときだけ **Blob API**（`GET /git/blobs/{sha}`、100MB まで）で本文を取る。PUT は従来どおり Contents API
- 実 API での確認（2026-09-04、一時ブランチ `api-probe` を切って実施し、確認後にブランチごと削除。main は無傷）:
  - `contents/decks/quiz-seikatsu.json`（1,153,842 バイト）の GET → `encoding: "none"`、`content` 空、`sha` あり
  - 同じ内容を `probe/large.json` へ Contents API で PUT → 201、`content.size` 1,153,842、コミット作成
  - `git/blobs/{sha}` → `encoding: "base64"`、本文 1,564,097 文字（改行入り）
- アプリ側の上限 `MAX_WRITABLE_DECK_BYTES` を 1MB → 100MB（Contents API 自体の対象外になる境界）へ。移動先の候補から3デッキが外れなくなる

### 比較した代替案

- 却下: Git Data API へ全面移行（blob → tree → commit → ref） — 移動を1コミットで原子的にできる利点はあるが、
  `writeDeck` / `createDeck` / `deleteDeck` と 409 リトライ・テスト一式を書き直すことになる。今回の障害は「読み」だけなので釣り合わない。
  移動の途中失敗は「両方にある」状態で止まり、次の `decks:sync` が add として拾う設計が既にある（`008`）
- 却下: raw URL（`raw.githubusercontent.com/.../{branch}/...`）で本文を取る — ブランチ指定の raw は CDN のキャッシュで数分古いことがある。
  取った本文と Contents API の sha が食い違うと、古い本文に変更を当てて PUT してしまう。sha に紐づく Blob API なら必ず一致する
- 却下: 3デッキを分割して 1MB 以下にする — デッキ id は進捗の鍵なので、分割は全カードの進捗を捨てることになる
- 採用: 上記の決定

### 影響範囲

- `moveTargets` の候補に公民・理系・生活が入る。`decks/README.md` の「1MB 超は xlsx 側で管理」の記述を改めた
- API 呼び出しが1回増えるのは 1MB 超のデッキだけ。小さいデッキは従来どおり1回で本文を得る

### 検証

- `tests/github-write.test.ts`: `encoding: "none"` の応答 → Blob API → 同じ sha で PUT、の順に呼ばれることと、改行入り base64 を復号できること
- `tests/deckedit.test.ts`: 上限を引き下げた場合の候補除外と、既定では 1MB 級も候補に入ること
- 兆候: GitHub が Contents API の PUT に 1MB 上限を設けたら書き込みが失敗する。その場合は Git Data API への移行（却下案1）へ進む
