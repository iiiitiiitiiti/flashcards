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
`scripts/import-quiz-xlsx.py` で生成している。**これらのファイルは手で編集しない**。
問題を直すときは xlsx を直して再生成するか、**アプリから直す**（下記「アプリからの編集と再生成」）。

```bash
pip3 install openpyxl          # 初回のみ
npm run decks:sync             # 生成 → 検証 → 差分表示 → commit・push
npm run decks:sync -- --dry-run    # commit せず差分だけ見る
```

`decks:sync` は次の順で動く（`scripts/sync-decks.mjs`）: 生成 → アプリ側の変更をマージ → 検証 → HEAD との差分 → commit・push。
**カード id が消えていたら一覧を出して止まる**。
消えた id の学習進捗は孤児になり復旧できないため、Excel の行削除・Q列「No」の書き換えを事故として扱う。
意図した削除なら `--allow-removals` を付ける。生成をやり直したいときは `git checkout -- decks` で戻せる。

生成だけしたい場合は従来どおり手で叩いてもよい（差分の確認は自分で行うこと）。

```bash
python3 scripts/import-quiz-xlsx.py
npm run validate:decks
```

- 大ジャンル → デッキの対応はスクリプト内の `GENRE_DECKS` が正本。**一度決めたデッキ id は変更しない**
- カード id は Q列「No」（静的な通し番号）の5桁ゼロ埋め。A列「No.」は `=ROW()-1` の数式で並べ替えるとずれるため使わない
- Q列が数値でない行（60件）は問題文の SHA-1 先頭10桁に `h` を付けた id にする。**該当行の問題文を書き換えると id が変わり、その問題の学習進捗は失われる**
- 問題の大ジャンルを xlsx 側で変更すると、そのカードは別デッキへ移動する。進捗は (デッキ id, カード id) で持つため、**ジャンルを変えると学習進捗は引き継がれない**
- **大ジャンルの問題がすべて無くなっても、そのデッキの JSON は残る**（importer は書き込むだけで削除しない）。デッキごと廃止するときは手でファイルを消す
- 1MB を超えるデッキ（quiz-koumin / quiz-rikei / quiz-seikatsu）は、GitHub Contents API の制限でアプリ内の「カード追加」「CSV取込」「編集」「移動」が使えない。xlsx 側で管理すること

## アプリからの編集と再生成（2026-09-04）

アプリ（iPhone）でカードの本文・タグ・所属デッキを直すと GitHub の `decks/*.json` にだけ入る。再生成でそれを消さないよう、
`decks:sync` は **3-way マージ**を行う（`scripts/merge-decks.mjs`、`docs/decisions/008`）。

- base = 前回の再生成コミット（件名「chore: クイズ.xlsx からデッキを再生成」。**この件名は変えない**）、ours = HEAD、theirs = xlsx から生成した結果
- theirs のカードが base のままなら ours（アプリの変更）を当てる。既に ours と同じなら何もしない。どちらとも違えば**衝突**として止まり、一覧が出る
  - `npm run decks:sync -- --on-conflict=xlsx` で xlsx 側を残して続行（推奨）、`--on-conflict=app` でアプリ側を通す
- タグは順序を無視して比べる。`quiz-sonota` は大ジャンル名がタグに入る特殊形なのでマージ対象外
- アプリで追加したカード（xlsx に行が無い）はアプリ側のデッキに残るが、xlsx へ行を足して No を振るまで毎回一覧に出る

マージで適用した変更は **xlsx へは自動では入らない**。`writeback-pending.json`（git 管理外）に出るので、次のどちらかで反映する。

```bash
npm run decks:sync -- --writeback          # xlwings で クイズ.xlsx へ書き戻す（Excel のある PC で。ブックは閉じておく）
# または writeback-pending.json を見て xlsx を手で直す
```

書き戻し（`scripts/writeback-quiz-xlsx.py`）は行を「No」列で特定し、現在値が前回生成時の値であることを確かめてから書く。
タグは 小ジャンル（I列）・難易度（D列）・出題済み（C列 `◯`）へ分解する。分解できない行・xlsx 側も変わっている行は書かずに一覧へ出す。
反映しなくても、次回の sync で theirs が ours と同じになった時点で一覧から消える。

アプリ側の制約（xlsx の列へ戻せる形に保つため）:

- 生成デッキでは**新しいタグを作れない**。既存タグから選ぶ。保存時に「小ジャンル系のタグはちょうど1つ・★は1つまで」を検査する
- カードの移動先は**同じ群**（生成デッキ同士）に限る。移動では移動先の既存タグから小ジャンルを選び直す。学習進捗・メモ・非表示も一緒に移る
