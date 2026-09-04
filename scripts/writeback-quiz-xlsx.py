#!/usr/bin/env python3
"""decks:sync がマージで適用した「アプリ側の変更」を クイズ.xlsx へ書き戻す。

使い方:
    python scripts/writeback-quiz-xlsx.py writeback-pending.json [xlsx のパス] [--dry-run]

    依存: xlwings + 実 Excel（openpyxl 保存は入力規則を壊すので使わない。quiz_io と同じ作法）

前提: 入力は sync-decks.mjs が書く JSON（kind / cardId / fromDeck / toDeck / base / ours）。
- 行は「No」列（静的な通し番号）で特定する。カード id が5桁数字でないものは xlsx に行が無い（アプリ追加）ので飛ばして一覧に出す
- 書く前に、行の現在値が base（前回生成時の値）か、既に ours（目標値）かを確かめる。どちらでもなければ
  xlsx 側でも変わっているので、その行は書かずに一覧へ出す（sync-decks.mjs の衝突判定と同じ3値）
- タグは 小ジャンル（I）・難易度（D）・出題済み（C）へ分解する。分解できない行は飛ばす
- 移動（fromDeck != toDeck）は 大ジャンル（H）を toDeck のジャンルにする
- 書く前に ~/.claude/quiz-backups/ へバックアップ。Excel でブックが開いていれば止める
"""

import glob
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from quizxlsx import SHEET, SHUTSUDAI_MARK, column_letter, is_difficulty_tag, locate_columns, split_tags, text  # noqa: E402

# デッキ id → 大ジャンル。import-quiz-xlsx.py の GENRE_DECKS の逆引き（そちらが正本）
from importlib import import_module  # noqa: E402

GENRE_DECKS = import_module("import-quiz-xlsx").GENRE_DECKS
DECK_TO_GENRE = {deck_id: genre for genre, (deck_id, _name) in GENRE_DECKS.items()}

DEFAULT_XLSX = Path.home() / "Library/CloudStorage/GoogleDrive-2190agiatotomijuf@gmail.com" / "マイドライブ/クイズ/クイズ.xlsx"
BACKUP_DIR = Path.home() / ".claude" / "quiz-backups"
BACKUP_KEEP = 10


def backup(path: Path) -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    dest = BACKUP_DIR / f"クイズ_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
    shutil.copy2(path, dest)
    for old in sorted(glob.glob(str(BACKUP_DIR / "クイズ_*.xlsx")))[:-BACKUP_KEEP]:
        os.remove(old)
    return dest


def card_columns(card: dict, deck_id: str) -> dict[str, str] | None:
    """カード → 列名ごとの値。タグが分解できなければ None"""
    parts = split_tags(card.get("tags") or [])
    if parts is None:
        return None
    subgenre, difficulty, shutsudai = parts
    return {
        "question": card["front"],
        "answer": card["back"],
        "note": card.get("note") or "",
        "genre": DECK_TO_GENRE.get(deck_id, ""),
        "subgenre": subgenre,
        "difficulty": difficulty,
        "shutsudai": SHUTSUDAI_MARK if shutsudai else "",
    }


def same_values(actual: dict[str, str], expected: dict[str, str]) -> bool:
    # 出題済みは「空か否か」だけを見る（既存データは "◯" と " " が混在する）
    for key, value in expected.items():
        if key == "shutsudai":
            if (actual[key] != "") != (value != ""):
                return False
        elif actual[key] != value:
            return False
    return True


def main() -> int:
    positional = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if not positional:
        print(__doc__, file=sys.stderr)
        return 2
    pending = json.loads(Path(positional[0]).read_text(encoding="utf-8"))
    xlsx = Path(positional[1]) if len(positional) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"xlsx が見つかりません: {xlsx}", file=sys.stderr)
        return 1
    if not pending:
        print("書き戻す変更はありません。")
        return 0

    try:
        import xlwings as xw
    except ImportError:
        print("xlwings がありません。xlsx へは書き戻せないので、次の行を手で直してください:", file=sys.stderr)
        for edit in pending:
            print(f"  {edit['kind']} {edit['cardId']}: {edit['ours']['front'][:40]}", file=sys.stderr)
        return 1
    for app in xw.apps:
        for book in app.books:
            if os.path.basename(book.fullname) == xlsx.name:
                print(f"ERROR: {xlsx.name} が Excel で開かれています。保存して閉じてから再実行してください。", file=sys.stderr)
                return 1

    skipped: list[str] = []
    writes: list[tuple[int, dict[str, str]]] = []

    app = xw.App(visible=False, add_book=False)
    app.display_alerts = False
    try:
        book = app.books.open(str(xlsx))
        sheet = book.sheets[SHEET]
        header = sheet.range("1:1").value
        col = locate_columns(header)
        letter = {key: column_letter(index) for key, index in col.items()}
        last_row = sheet.range(f"{letter['serial']}1").end("down").row
        serials = sheet.range(f"{letter['serial']}2:{letter['serial']}{last_row}").value
        row_by_serial: dict[int, int] = {}
        for offset, value in enumerate(serials, start=2):
            if isinstance(value, (int, float)) and float(value).is_integer():
                row_by_serial.setdefault(int(value), offset)

        for edit in pending:
            card_id = edit["cardId"]
            label = f"{edit['kind']} {card_id} ({edit.get('fromDeck')} → {edit.get('toDeck')}): {edit['ours']['front'][:30]}"
            if not (card_id.isdigit() and len(card_id) == 5):
                skipped.append(f"{label} — xlsx に行が無い（アプリで追加したカード）。行を足して No を振ってください")
                continue
            row = row_by_serial.get(int(card_id))
            if row is None:
                skipped.append(f"{label} — No {int(card_id)} の行が見つからない")
                continue
            target = card_columns(edit["ours"], edit["toDeck"])
            if target is None:
                skipped.append(f"{label} — タグを 小ジャンル/難易度/出題済み に分解できない: {edit['ours'].get('tags')}")
                continue
            if target["genre"] == "":
                skipped.append(f"{label} — デッキ「{edit['toDeck']}」に対応する大ジャンルが無い")
                continue
            actual = {key: text(sheet.range(f"{letter[key]}{row}").value) for key in target}
            if same_values(actual, target):
                continue  # 既に反映済み
            base_cols = card_columns(edit["base"], edit["fromDeck"]) if edit.get("base") else None
            if base_cols is None or not same_values(actual, base_cols):
                skipped.append(f"{label} — xlsx 側も変わっている（行 {row}）。どちらが正しいか決めて手で直してください")
                continue
            writes.append((row, target))

        print(f"書き戻し {len(writes)} 行 / 飛ばした {len(skipped)} 件（dry-run={dry_run}）")
        for line in skipped:
            print(f"  ! {line}")
        if writes and not dry_run:
            print(f"backup: {backup(xlsx)}")
            for row, target in writes:
                for key, value in target.items():
                    if key == "shutsudai":
                        sheet.range(f"{letter[key]}{row}").value = value if value else None
                    else:
                        sheet.range(f"{letter[key]}{row}").value = value if value != "" else None
            book.save()
            print(f"クイズ.xlsx へ {len(writes)} 行を書き込みました。")
        book.close()
    finally:
        app.quit()
    return 1 if skipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
