## 018. Node 25 の native localStorage は vitest の `execArgv` で外す（Node の固定や setup ファイルではなく）

- 日付: 2026-09-08
- 対象: `vite.config.ts`（`test.execArgv`）、`tests/settings-view.test.tsx`・`tests/study-view.test.tsx` など `localStorage` を直接使うテスト

### 背景

Mac（Node 25.9）で `npm test` を回すと、Windows で書かれた `settings-view` 3 件と `study-view` 1 件が
`localStorage.clear is not a function` で落ちた。Node 25 はメソッドを持たない `localStorage` オブジェクトを
グローバルに置いており（`--localstorage-file` 未指定のときの姿）、`// @vitest-environment jsdom` を付けても
jsdom の `localStorage` がそれに隠れる。2026-08-27 の設計メモではこの理由で「テストから `localStorage.clear()` を呼ばない」と
回避していたが、その後 Windows 側で書かれたテストが直接使っており、OS ごとに結果が違う状態になっていた。

### 決定

`vite.config.ts` の `test.execArgv` に `--no-experimental-webstorage` を入れ、vitest の worker を起動する Node から
native の localStorage を外す。以後、テストは jsdom の `localStorage` を素直に使ってよい。

### 比較した代替案

- 却下: `.nvmrc` などで Node を 24 以下に固定する — Mac の Node を下げる理由がこれだけで、他のプロジェクトにも波及する。テストの都合で開発環境を縛るのは逆向き
- 却下: setup ファイルで `delete globalThis.localStorage` してから jsdom を当てる — Node の getter は configurable でない可能性があり、jsdom 環境の初期化順にも依存する。フラグ 1 つで済むところを増やす理由がない
- 却下: テストで `localStorage` を使わずに `storage.ts` の関数経由に書き換える（2026-08-27 の回避を徹底する） — 設定の保存先が localStorage であること自体を確かめたいテストには使えない。回避の継続であって解決ではない
- 採用: `test.execArgv: ["--no-experimental-webstorage"]`

### 影響範囲

- フラグは Node 22.4 以降で受け付ける。Windows 側の Node がそれより古いと worker の起動で落ちるので、pull 後に `npm test` を 1 回回して確認する（2026-09-08 の Windows 向け引き継ぎに記載）
- `docs/design-decisions.md` 2026-08-27 節の「`localStorage.clear()` は呼べない」は解消済みの注記を追加した

### 検証

- 追加前: Mac で 4 件失敗（HEAD `bdc1a24` でも同じ 4 件が失敗し、今回の変更と無関係であることを確認）
- 追加後: Mac で 26 ファイル / 316 件すべて通過
- 兆候: Node が webstorage を既定で有効にしフラグを廃止したら、この設定が warning か起動失敗になる。そのときは jsdom 側の `localStorage` を明示的に `globalThis` へ載せる方法に切り替える

### 関連ファイル

- `vite.config.ts`
- `docs/design-decisions.md`（2026-08-27 節）
- `tests/settings-view.test.tsx`
