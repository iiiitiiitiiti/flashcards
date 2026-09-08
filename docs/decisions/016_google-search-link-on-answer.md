## 016. 答えの下に Google 検索リンクを置き、答えの文字列をそのまま検索語にする

- 日付: 2026-09-07
- 対象: `src/StudyView.tsx`（`SearchLink`）、`src/text.ts`（`googleSearchUrl`）、`src/styles.css`（`.study-search`）

### 背景

答えを見たあとに「これ何だっけ」と調べたくなることがある（2026-09-07 ユーザー要望）。
答えを選択してコピーし、ブラウザへ貼る手間を、1 タップにする。

### 決定

1. **答え・補足・メモの下に「Google で答えを検索」のリンク**を出す。通常モードと早押しモードの両方。新しいタブで開く（`target="_blank"` + `noopener`）
2. **検索語は答えの文字列そのまま。** 改行と連続する空白だけ 1 つに畳む。括弧の読みや別解（1,710 枚にある）は消さない。検索側で十分に扱え、URL を見れば何を検索したか分かる
3. **リンク上の操作はカードへ伝えない**（`click` と `pointerdown` の `stopPropagation`）。カード本体はタップで裏返り、横に引くと評価になるので、押した瞬間に裏返って開かない・引きずりが評価として扱われないようにする
4. 見た目は小さめの文字と下線のリンク。タップ領域は 38px（このリポのボタン下限）

### 比較した代替案

- 却下: 括弧書きや別解を削って検索語にする — 「Ｂ（ビー）」のように括弧が本体の一部のことがあり、削ると別物になる。そのまま渡す
- 却下: ヘッダーのアイコン列（メモ・非表示・編集の並び）に置く — 答えを見てから使う操作なので、答えの直下にあるほうが目線の移動が少ない。表向きでは意味を持たない
- 却下: 問題文も検索語に含める — 長くなり、答えのページが上位に来にくい
- 却下: 検索エンジンを設定で選べるようにする — 要望は Google 固定。必要になったら足す
- 採用: 上記の決定

### 影響範囲

- 通常モードは裏面をあらかじめ描いてめくる作りなので、リンクは表向きのときも DOM にある（`aria-hidden` の面の中）
- PWA（iPhone のホーム画面から起動）では新しいタブは Safari 側で開く。戻れば学習は続いている

### 検証

- `tests/text.test.ts`（+2 件）: URL エンコード、改行・連続空白の畳み込み
- `tests/study-view.test.tsx`（+2 件）: 答えを出すとリンクが出て href が答えの検索 URL、リンクを押してもカードは裏返ったまま評価ボタンが残る、早押しでも出る。全 308 件通過
- preview + Chrome: IT・ネットのカードで「スプラッシュスクリーン」の検索 URL、リンクの高さ 38px、押しても裏返らない。横スクロールなし
- 兆候: 早押しの一問一答で答えが長文のカード（複数行の答え 106 枚）で検索語が長すぎる声（先頭の 1 行だけにする）

### 2026-09-08 改訂: 答えの下のリンクから、カード上のアイコン列（編集の左）へ移す

- 対象: `src/StudyView.tsx`（`SearchAction`・`GoogleIcon`）、`src/styles.css`（`.card-action-link`）、`src/main.tsx`（押下表現の対象に追加）
- ユーザー指定で、右上の編集ボタンの左に並べる形へ変更。アイコンは Google 公式の「Sign in with Google」ボタンの SVG（4色ロゴ）をそのまま使う
- 表向きの間は隣のボタンと同じく非活性（薄い表示・href なし・`aria-disabled`）にし、答えを出すと押せるようにする。通常・早押しの両方。当初は答えを出している間だけ描いていたが、同日「隣のボタンたちと同じように非活性にしてほしい」と指示され変更
- 答えの下の文字リンク（`.study-search`）は削除。同じ操作の入口を 2 つ置かない
- カードの外にあるので、`stopPropagation` は不要になった（押しても裏返らない・引きずりが評価にならない、はテストで維持）
- `a` 要素なので button の既定スタイルが当たらない。`.card-action-link` で枠・背景・押下表現を button に揃え、iOS 向けの `data-pressed` の対象にも加えた
- 検証: `tests/study-view.test.tsx` を差し替え（答えを出すまでは出ない・右側の列の先頭にあり次が編集・押しても裏返らない・早押しでも出る）。全 308 件通過。preview + headless Chromium（390px）で、36px の丸ボタン・4色ロゴ・新しいタブで検索 URL が開く・横スクロールなしを確認

### 2026-09-08 追記: iOS で Google アプリに横取りされないよう `noiga=1` を付ける

- 対象: `src/text.ts`（`googleSearchUrl`）
- iPhone で押すと既定のブラウザではなく Google アプリが開いた（ユーザー報告）。google.com は `/search` を Universal Links に登録しているため
- Apple の CDN 経由で取得した google.com の apple-app-site-association に、`noiga=1`（どのパスでも）と `/search?iga=0` を除外する規則が明記されている。公開されている opt-out なので、これを検索 URL に付ける
- 却下: `window.open` で JS から開く — Universal Links の発火条件が iOS の版で揺れ、確実ではない
- 却下: google.co.jp など別ドメイン — AASA は同じ内容で、やはり `/search` が登録されている
- 兆候: Google 側が AASA から `noiga` を消したら再発する。そのときは URL の形を変える

### 2026-09-08 追記: ホーム画面版では、設定で選んだブラウザのアプリへ渡す

- 対象: `src/storage.ts`（`SEARCH_BROWSERS`・`loadSearchBrowser`）、`src/text.ts`（`isIosStandalone`・`browserUrl`）、`src/StudyView.tsx`、`src/SettingsView.tsx`（「答えの検索」）
- iPhone のホーム画面から起動した PWA では、外部リンクが iOS のアプリ内ブラウザで開く（ユーザー報告: 「アプリ内のブラウザで開いている。既定のブラウザへ遷移したい」。既定は Vivaldi）
- Web アプリから端末の既定ブラウザは検出できないし、既定ブラウザへ「渡す」API も無い。各ブラウザが登録している URL スキームに差し替えるしかないので、設定「Google 検索を開くブラウザ」（アプリ内／Safari／Vivaldi／Chrome。既定はアプリ内）を置き、`navigator.standalone` が真のときだけそのスキームで開く
- スキームの根拠: Safari は `x-safari-https://`（非公開だが広く使われている）、Chrome は `googlechromes://`（公開仕様）、Vivaldi は `vivaldi://`（公式資料は見つからず。Telegram iOS のソース `OpenInOptions.swift` が「Vivaldi で開く」にこの形を使っているのを根拠にした）
- 却下: Safari 固定の `x-safari-https://` — ユーザーの既定が Vivaldi なので Safari が開いてしまう
- 却下: `window.open` や JS 経由の遷移 — 標準では standalone のアプリ内ブラウザから出られない
- 却下: UA からブラウザを推定 — standalone の UA は Safari 相当で、既定ブラウザの情報は無い
- 兆候: Vivaldi 側がスキームを変えると開かなくなる（iOS は未登録スキームを無視する）。そのときは Safari か Chrome に切り替えて使える
- 検証: `tests/text.test.ts`（スキーム差し替え 4 種・standalone 判定）、`tests/study-view.test.tsx`（standalone＋Vivaldi 設定で `vivaldi://` の href と target なし／standalone でもアプリ内なら https＋新しいタブ）。全 312 件通過。preview＋headless Chromium で `navigator.standalone` を真にして、設定で Vivaldi を選ぶと href が `vivaldi://www.google.com/search?...&noiga=1` になることを確認。実機（Vivaldi が開くか）は未検証

### 2026-09-08 追記: 次のカードへ飛ばしている間も、隣のボタンと同じ瞬間に非活性にする

- ユーザー報告: 「次のカードに切り替わるとき、Google の非活性になるタイミングが隣とズレる」
- 原因: 隣（編集・メモ・非表示）は評価の瞬間に `saving` で非活性になるが、Google は `revealed` だけを見ていた。`revealed` が偽になるのは飛ばしのアニメーション（`FLY_OUT_MS`）が終わってキューを進めた後なので、その間だけ Google が活性のまま残っていた
- 対応: `disabled={!revealed || saving}`。headless Chromium で評価直後から 30ms ごとに両者を記録し、評価の瞬間から同時に非活性になることを確認（その後メモが先に活性へ戻るのは、次のカードの答えが未表示だから。仕様どおり）
