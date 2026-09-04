#!/usr/bin/env python3
"""クイズ.xlsx の「ノンジャンルクイズ」シートから大ジャンル別のデッキ JSON を生成する。

使い方:
    python3 scripts/import-quiz-xlsx.py [xlsx のパス]

    依存: openpyxl（`pip3 install openpyxl`）

何度実行しても同じ入力からは同じ出力になる（冪等）。
カード id は学習進捗の紐づけキーなので、**絶対に振り直さない**こと。
- A列「No.」は `=ROW()-1` の数式で並べ替えるとずれるため使わない
- 「No」列（静的な通し番号。2026-09 時点で U 列）を5桁ゼロ埋めして id にする。列はヘッダー名で探す
- 「No」が数値でない行は問題文の SHA-1 先頭10桁に "h" を付けた id にする
"""

import hashlib
import json
import re
import sys
from pathlib import Path

import openpyxl

DEFAULT_XLSX = (
    Path.home()
    / "Library/CloudStorage/GoogleDrive-2190agiatotomijuf@gmail.com"
    / "マイドライブ/クイズ/クイズ.xlsx"
)
SHEET = "ノンジャンルクイズ"
DECKS_DIR = Path(__file__).resolve().parent.parent / "decks"

# 列はヘッダー名で探す（2026-09-04）。以前は固定位置（Q列 = 16）で読んでいたが、
# xlsx に列が挿入されて「No」が U 列へ動き、固定位置のままだと全カードが h 付きの
# ハッシュ id になって学習進捗が全部孤児になるところだった。
# 値は「ヘッダー名, 前方一致か」。問題文の見出しは「問題文（問題数：29772）」のように件数を含む
COLUMN_HEADERS = {
    "shutsudai": ("出題", False),
    "difficulty": ("難易度", False),
    "question": ("問題文", True),
    "answer": ("解答", False),
    "note": ("別解･正誤判定基準･補足", False),
    "genre": ("大ジャンル", False),
    "subgenre": ("小ジャンル", False),
    # 静的な通し番号。A列の「No.」（ピリオド付き・=ROW()-1 の数式）とは別物
    "serial": ("No", False),
}


def locate_columns(header: tuple) -> dict[str, int]:
    """ヘッダー行から各列の位置（0 始まり）を返す。見つからない・複数あるなら止める"""
    names = [text(cell) for cell in header]
    found: dict[str, int] = {}
    for key, (name, prefix) in COLUMN_HEADERS.items():
        hits = [i for i, n in enumerate(names) if (n.startswith(name) if prefix else n == name)]
        if len(hits) != 1:
            raise SystemExit(f"ヘッダー「{name}」が {len(hits)} 列見つかりました（1列でなければなりません）: {names}")
        found[key] = hits[0]
    return found

# 大ジャンル → デッキ id。**一度決めたら変更しない**（ファイル名 = 進捗のキー）
GENRE_DECKS: dict[str, tuple[str, str]] = {
    "理系": ("quiz-rikei", "クイズ: 理系"),
    "生活": ("quiz-seikatsu", "クイズ: 生活"),
    "公民": ("quiz-koumin", "クイズ: 公民"),
    "地理": ("quiz-chiri", "クイズ: 地理"),
    "スポーツ": ("quiz-sports", "クイズ: スポーツ"),
    "日本史･世界史": ("quiz-rekishi", "クイズ: 日本史・世界史"),
    "文学": ("quiz-bungaku", "クイズ: 文学"),
    "言葉": ("quiz-kotoba", "クイズ: 言葉"),
    "音楽": ("quiz-ongaku", "クイズ: 音楽"),
    "芸能": ("quiz-geinou", "クイズ: 芸能"),
    "漫画･アニメ･ゲーム": ("quiz-manga", "クイズ: 漫画・アニメ・ゲーム"),
    "生き物": ("quiz-ikimono", "クイズ: 生き物"),
    "芸術": ("quiz-geijutsu", "クイズ: 芸術"),
    "趣味･娯楽": ("quiz-shumi", "クイズ: 趣味・娯楽"),
    "IT･ネット": ("quiz-it", "クイズ: IT・ネット"),
}
FALLBACK_DECK = ("quiz-sonota", "クイズ: その他")

ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


def text(value) -> str:
    return "" if value is None else str(value).strip()


def card_id(serial, question: str) -> str:
    # 静的な通し番号があればそれを使い、無ければ問題文から不変の id を作る
    if isinstance(serial, int) and serial > 0:
        return f"{serial:05d}"
    return "h" + hashlib.sha1(question.encode("utf-8")).hexdigest()[:10]


def main() -> int:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"xlsx が見つかりません: {xlsx}", file=sys.stderr)
        return 1

    sheet = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)[SHEET]
    rows = sheet.iter_rows(values_only=True)
    col = locate_columns(next(rows))  # ヘッダー

    decks: dict[str, dict] = {}
    seen_ids: dict[str, dict[str, int]] = {}
    skipped_empty = 0
    duplicates: list[str] = []

    for row_number, row in enumerate(rows, start=2):
        question, answer = text(row[col["question"]]), text(row[col["answer"]])
        if not question or not answer:
            skipped_empty += 1
            continue

        genre = text(row[col["genre"]])
        deck_id, deck_name = GENRE_DECKS.get(genre, FALLBACK_DECK)
        deck = decks.setdefault(
            deck_id,
            {"schemaVersion": 1, "id": deck_id, "name": deck_name, "description": "", "cards": []},
        )
        ids = seen_ids.setdefault(deck_id, {})

        identifier = card_id(row[col["serial"]], question)
        if not ID_PATTERN.match(identifier):
            raise SystemExit(f"id が規約に合いません: {identifier!r}")
        if identifier in ids:
            # 黙って捨てると、どちらの問題の進捗なのか分からなくなる。必ず人が直す
            duplicates.append(
                f"  id {identifier}: {row_number} 行目と {ids[identifier]} 行目\n"
                f"    今の行: {question[:40]}"
            )
            continue
        ids[identifier] = row_number

        card = {"id": identifier, "front": question, "back": answer}
        note = text(row[col["note"]])
        if note:
            card["note"] = note
        tags = [tag for tag in (text(row[col["subgenre"]]), text(row[col["difficulty"]])) if tag]
        if genre and genre not in GENRE_DECKS:
            tags.append(genre)
        if text(row[col["shutsudai"]]):
            tags.append("出題済み")
        if tags:
            card["tags"] = tags
        deck["cards"].append(card)

    if duplicates:
        raise SystemExit(
            "同じカード id が複数の行に現れました。Q列「No」を直してから再実行してください。\n"
            "（id が重複したままだと、学習進捗が別の問題に紐づきます）\n" + "\n".join(duplicates)
        )

    total = 0
    for deck_id, deck in sorted(decks.items()):
        deck["description"] = f"クイズ.xlsx「{SHEET}」より {len(deck['cards'])} 問"
        path = DECKS_DIR / f"{deck_id}.json"
        # Windows で実行しても改行を LF に固定する（既定だと CRLF になり、全行が差分になる）
        path.write_text(json.dumps(deck, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        size = path.stat().st_size / 1024
        total += len(deck["cards"])
        print(f"{path.name:24} {len(deck['cards']):6} 問  {size:8.0f} KB")

    print(f"\n合計 {total} 問 / {len(decks)} デッキ（空行スキップ {skipped_empty}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
