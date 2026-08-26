# decks/ — デッキ作成規約

このフォルダの JSON がデッキの正本。アプリは main ブランチのこのフォルダを起動時に読み込む。
Claude・人間ともに、デッキを追加・編集するときは必ずこの規約に従うこと。

## ファイル

- 1 デッキ = 1 ファイル。ファイル名は `<deckId>.json`
- JSON 内の `id` は**ファイル名（拡張子抜き）と完全一致**させる。不一致はアプリが読み込みを拒否する
- **ファイル名の変更（リネーム）は禁止**。学習進捗はデッキ id に紐づくため、リネームすると進捗が失われる

## スキーマ（schemaVersion: 1）

```json
{
  "schemaVersion": 1,
  "id": "kanji-yomi",
  "name": "漢字の読み",
  "description": "任意の説明（省略可）",
  "cards": [
    {
      "id": "001",
      "front": "問題（表面）",
      "back": "答え（裏面）",
      "note": "補足メモ（省略可）",
      "tags": ["タグ1", "タグ2"]
    }
  ]
}
```

- 必須: `schemaVersion`(1固定) / `id` / `name` / `cards[].id` / `cards[].front` / `cards[].back`
- 省略可: `description` / `cards[].note` / `cards[].tags`
- `id`（デッキ・カードとも）は英数字・ハイフン・アンダースコアのみ（`^[A-Za-z0-9][A-Za-z0-9_-]*$`）

## カード id のルール（進捗を壊さないために最重要）

- **デッキ内で一意・一度使ったら不変・削除後も再利用禁止**
- 手書きで追加するなら連番（"001", "002", …）でよい。既存の最大番号より先へ進める
- カードを削除しても、その id を新しいカードに使い回さない（過去の学習進捗が誤って引き継がれる）
- カードの front/back を微修正しても id は変えない（進捗が引き継がれる）。**意味が別問題になるほど変えるなら、旧カードを削除して新 id で追加**する

## 追加・編集の手順（Claude 向け）

1. 既存ファイルを読み、規約と id 採番を確認する
2. `npm run validate:decks` で検証してから commit・push する
3. push すると GitHub Actions（validate-decks）でも同じ検証が走る。失敗したら即修正する

## クイズ.xlsx からの一括生成（quiz-* デッキ）

`quiz-rikei` 〜 `quiz-sonota` の16デッキは、Google Drive の `クイズ/クイズ.xlsx`「ノンジャンルクイズ」シートから
`scripts/import-quiz-xlsx.py` で生成している。**これらのファイルは手で編集しない**（次の生成で上書きされる）。
問題を直すときは xlsx を直し、再生成する。

```bash
pip3 install openpyxl          # 初回のみ
python3 scripts/import-quiz-xlsx.py
npm run validate:decks
```

- 大ジャンル → デッキの対応はスクリプト内の `GENRE_DECKS` が正本。**一度決めたデッキ id は変更しない**
- カード id は Q列「No」（静的な通し番号）の5桁ゼロ埋め。A列「No.」は `=ROW()-1` の数式で並べ替えるとずれるため使わない
- Q列が数値でない行（60件）は問題文の SHA-1 先頭10桁に `h` を付けた id にする。**該当行の問題文を書き換えると id が変わり、その問題の学習進捗は失われる**
- 問題の大ジャンルを xlsx 側で変更すると、そのカードは別デッキへ移動する。進捗は (デッキ id, カード id) で持つため、**ジャンルを変えると学習進捗は引き継がれない**
- 1MB を超えるデッキ（quiz-koumin / quiz-rikei / quiz-seikatsu）は、GitHub Contents API の制限でアプリ内の「カード追加」「CSV取込」が使えない。xlsx 側で管理すること
