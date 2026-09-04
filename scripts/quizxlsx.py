"""クイズ.xlsx「ノンジャンルクイズ」の列の探し方。import-quiz-xlsx.py と writeback-quiz-xlsx.py で共有する。

列は固定位置ではなく**ヘッダー名**で探す（2026-09-04）。以前は固定位置（Q列 = 16）で読んでいたが、
xlsx に列が挿入されて「No」が U 列へ動き、固定位置のままだと全カードが h 付きのハッシュ id になって
学習進捗が全部孤児になるところだった。読み（openpyxl）と書き（xlwings）で同じ関数を使い、二重実装にしない。
"""

SHEET = "ノンジャンルクイズ"

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

# 出題済みの印（C列）。importer は「空でなければ出題済み」と読むので、書くときはこの値に揃える
SHUTSUDAI_MARK = "◯"
SHUTSUDAI_TAG = "出題済み"


def text(value) -> str:
    return "" if value is None else str(value).strip()


def locate_columns(header) -> dict[str, int]:
    """ヘッダー行（セル値の並び）から各列の位置（0 始まり）を返す。見つからない・複数あるなら止める"""
    names = [text(cell) for cell in header]
    found: dict[str, int] = {}
    for key, (name, prefix) in COLUMN_HEADERS.items():
        hits = [i for i, n in enumerate(names) if (n.startswith(name) if prefix else n == name)]
        if len(hits) != 1:
            raise SystemExit(f"ヘッダー「{name}」が {len(hits)} 列見つかりました（1列でなければなりません）: {names}")
        found[key] = hits[0]
    return found


def column_letter(index: int) -> str:
    """0 始まりの列位置 → Excel の列記号（xlwings の range 指定用）"""
    letters = ""
    index += 1
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        letters = chr(ord("A") + remainder) + letters
    return letters


def is_difficulty_tag(tag: str) -> bool:
    """★☆☆ のような難易度タグか（D列に入る）"""
    return tag != "" and set(tag) <= {"★", "☆"}


def split_tags(tags: list[str]) -> tuple[str, str, bool] | None:
    """デッキのタグを xlsx の列へ分解する: (小ジャンル, 難易度, 出題済み)。分解できなければ None

    importer は [小ジャンル, 難易度, 出題済み] の順に並べるが、アプリ側は順序を保証しないので種類で見分ける。
    小ジャンルは**ちょうど1つ**、難易度は1つまで。それ以外の自由タグがあれば None。
    """
    subgenres = [tag for tag in tags if not is_difficulty_tag(tag) and tag != SHUTSUDAI_TAG]
    difficulties = [tag for tag in tags if is_difficulty_tag(tag)]
    if len(subgenres) != 1 or len(difficulties) > 1:
        return None
    return subgenres[0], (difficulties[0] if difficulties else ""), SHUTSUDAI_TAG in tags
