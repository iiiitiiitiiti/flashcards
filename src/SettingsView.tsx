import { useEffect, useRef, useState } from "react";
import { downloadBackup, importBackup, parseBackupBytes } from "./backup";
import { BACKUP_PATH, BACKUP_REPOSITORY, listCloudBackups, restoreFromCloud, uploadBackup } from "./cloudbackup";
import { deleteProgressByKeys, readAllProgress } from "./db";
import { estimateStorage, formatBytes, isQuotaExceeded, type StorageUsage } from "./quota";
import { OWNER, testConnection, type FileCommit } from "./github";
import {
  loadAutoCloudBackup,
  loadCloudBackupError,
  loadLastCloudBackupAt,
  saveAutoCloudBackup,
  saveCloudBackupError,
  saveLastCloudBackupAt,
  saveLastCloudBackupAttemptAt,
  type CloudBackupError,
  BUZZER_SPEEDS,
  clearToken,
  loadBuzzerSpeed,
  loadLastBackupAt,
  loadMotionPreference,
  loadNewCardsPerDay,
  loadNewCardsScope,
  loadRatingThresholds,
  loadToken,
  saveBuzzerSpeed,
  saveLastBackupAt,
  saveMotionPreference,
  saveNewCardsPerDay,
  saveNewCardsScope,
  saveRatingThresholds,
  saveToken,
  tokenPersistence,
} from "./storage";
import { NEW_CARDS_PER_DAY_OPTIONS, normalizeRatingThresholds } from "./srs";
import type { DeckSnapshot, NewCardsScope, RatingThresholds } from "./types";

interface SettingsViewProps {
  snapshot: DeckSnapshot | null;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SettingsView({ snapshot }: SettingsViewProps) {
  const deckCount = snapshot?.decks.length ?? null;
  const [token, setToken] = useState(loadToken());
  const [persistToken, setPersistToken] = useState(tokenPersistence() !== "session");
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState(loadLastBackupAt());
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [autoCloud, setAutoCloud] = useState(loadAutoCloudBackup);
  const [lastCloudBackupAt, setLastCloudBackupAt] = useState(loadLastCloudBackupAt);
  const [cloudError, setCloudError] = useState<CloudBackupError | null>(loadCloudBackupError);
  const [cloudMessage, setCloudMessage] = useState<string | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  /** 復元できる版。「版を選ぶ」を押すまで取らない（API 呼び出しを増やさない） */
  const [cloudVersions, setCloudVersions] = useState<FileCommit[] | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("main");
  const [orphanMessage, setOrphanMessage] = useState<string | null>(null);
  const [crossfade, setCrossfade] = useState(loadMotionPreference() === "crossfade");
  const [buzzerSpeed, setBuzzerSpeed] = useState(loadBuzzerSpeed);
  const [newCardsPerDay, setNewCardsPerDay] = useState(loadNewCardsPerDay);
  const [newCardsScope, setNewCardsScope] = useState<NewCardsScope>(loadNewCardsScope);
  const [thresholds, setThresholds] = useState<RatingThresholds>(loadRatingThresholds);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleMotionChange(next: boolean) {
    setCrossfade(next);
    const preference = next ? "crossfade" : "full";
    saveMotionPreference(preference);
    document.documentElement.dataset.motion = preference;
  }

  function handleNewCardsPerDayChange(value: number) {
    setNewCardsPerDay(value);
    saveNewCardsPerDay(value);
  }

  function handleNewCardsScopeChange(value: NewCardsScope) {
    setNewCardsScope(value);
    saveNewCardsScope(value);
  }

  function handleBuzzerSpeedChange(ms: number) {
    setBuzzerSpeed(ms);
    saveBuzzerSpeed(ms);
  }

  function handleThresholdChange(key: keyof RatingThresholds, value: string) {
    // 入力途中は素通しし、保存時にだけ昇順・上限へ整える
    const next = { ...thresholds, [key]: Number(value) };
    setThresholds(next);
    saveRatingThresholds(next);
  }

  function handleThresholdBlur() {
    setThresholds(normalizeRatingThresholds(thresholds));
  }

  useEffect(() => {
    void estimateStorage().then(setUsage);
  }, []);

  function handleSaveToken() {
    if (token.trim() === "") {
      clearToken();
      setTokenMessage("トークンを削除しました。");
      return;
    }
    saveToken(token, persistToken);
    setTokenMessage(persistToken ? "トークンをこの端末に保存しました。" : "トークンをセッション限定で保存しました。");
  }

  async function handleTestConnection() {
    setTesting(true);
    setTokenMessage(null);
    try {
      const result = await testConnection(token.trim());
      // バックアップ用リポは「届くか」だけを見る。permissions.push が fine-grained PAT の
      // Contents 権限を映す保証が無いので、書き込みは「今すぐ保存」で確かめる
      let backupAccess: string;
      try {
        await testConnection(token.trim(), BACKUP_REPOSITORY);
        backupAccess = "アクセス可";
      } catch (error) {
        backupAccess = error instanceof Error ? error.message : "アクセス不可";
      }
      setTokenMessage(
        `接続成功: ${result.repository}（書き込み: ${result.writeAccess === "available" ? "可" : result.writeAccess === "unavailable" ? "不可" : "未確認"}）。バックアップ用 ${BACKUP_REPOSITORY}: ${backupAccess}`,
      );
    } catch (error) {
      setTokenMessage(error instanceof Error ? error.message : "接続テストに失敗しました。");
    } finally {
      setTesting(false);
    }
  }

  async function handleExport() {
    setBackupMessage(null);
    try {
      const { blob, exportedAt, progressCount, logCount, noteCount } = await downloadBackup();
      saveLastBackupAt(exportedAt);
      setLastBackupAt(exportedAt);
      setBackupMessage(`進捗 ${progressCount} 件・ログ ${logCount} 件・メモ ${noteCount} 件（${formatBytes(blob.size)}）を書き出しました。`);
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : "エクスポートに失敗しました。");
    }
  }

  async function handleImportFile(file: File) {
    setBackupMessage(null);
    try {
      // GitHub から手で落とした .json.gz も、手動書き出しの .json も同じ入口で読む
      const parsed = await parseBackupBytes(new Uint8Array(await file.arrayBuffer()));
      const result = await importBackup(parsed);
      setBackupMessage(
        `インポート完了: 進捗 ${result.progressImported} 件更新・${result.progressSkipped} 件スキップ・ログ ${result.logsImported} 件追加・メモ ${result.notesImported} 件・非表示 ${result.hiddenImported} 件。`,
      );
    } catch (error) {
      const reason = isQuotaExceeded(error)
        ? "端末の保存容量が足りません。空きを増やしてからお試しください"
        : error instanceof Error
          ? error.message
          : "不明なエラー";
      setBackupMessage(`インポート失敗（何も変更していません）: ${reason}`);
    }
  }

  function handleAutoCloudChange(next: boolean) {
    setAutoCloud(next);
    saveAutoCloudBackup(next);
  }

  async function handleCloudUpload() {
    const current = token.trim();
    if (current === "") return;
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const result = await uploadBackup(current);
      saveLastCloudBackupAt(result.exportedAt);
      saveLastCloudBackupAttemptAt(result.exportedAt);
      saveCloudBackupError(null);
      setLastCloudBackupAt(result.exportedAt);
      setCloudError(null);
      setCloudMessage(`GitHub へ保存しました: 進捗 ${result.progressCount} 件・ログ ${result.logCount} 件・メモ ${result.noteCount} 件（gzip ${formatBytes(result.bytes)}）。`);
      setCloudVersions(null);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "GitHub への保存に失敗しました。");
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleLoadCloudVersions() {
    const current = token.trim();
    if (current === "") return;
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const versions = await listCloudBackups(current);
      setCloudVersions(versions);
      setSelectedVersion("main");
      if (versions.length === 0) setCloudMessage("GitHub にバックアップがまだありません。");
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : "版の一覧を取得できませんでした。");
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleCloudRestore() {
    const current = token.trim();
    if (current === "") return;
    setCloudBusy(true);
    setCloudMessage(null);
    try {
      const restored = await restoreFromCloud(current, selectedVersion);
      const { result } = restored;
      setCloudMessage(
        `${formatTimestamp(restored.exportedAt)} 時点のバックアップを統合しました: 進捗 ${result.progressImported} 件更新・${result.progressSkipped} 件は端末側が新しいので維持・ログ ${result.logsImported} 件追加・メモ ${result.notesImported} 件・非表示 ${result.hiddenImported} 件。`,
      );
    } catch (error) {
      const reason = isQuotaExceeded(error)
        ? "端末の保存容量が足りません。空きを増やしてからお試しください"
        : error instanceof Error
          ? error.message
          : "不明なエラー";
      setCloudMessage(`復元失敗（何も変更していません）: ${reason}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleDeleteOrphans() {
    setOrphanMessage(null);
    if (!snapshot) {
      setOrphanMessage("デッキ情報を読み込めていないため実行できません。");
      return;
    }
    const cardsByDeck = new Map(snapshot.decks.map((entry) => [entry.deckId, new Set(entry.deck.cards.map((card) => card.id))]));
    const orphans = (await readAllProgress()).filter((record) => !cardsByDeck.get(record.deckId)?.has(record.cardId));
    if (orphans.length === 0) {
      setOrphanMessage("孤児進捗はありません。");
      return;
    }
    if (!window.confirm(`どのデッキにも存在しないカードの進捗 ${orphans.length} 件を削除しますか？`)) return;
    await deleteProgressByKeys(orphans.map((record) => [record.deckId, record.cardId]));
    setOrphanMessage(`${orphans.length} 件削除しました。`);
  }

  return (
    <section>
      <header className="app-header app-header-centered">
        <h1>各種設定</h1>
      </header>

      <h2>GitHub トークン（編集用）</h2>
      <p className="muted">
        カードの追加・編集を GitHub に保存するには fine-grained PAT（このリポジトリの Contents: Read and write）が必要です。学習だけなら不要です。
      </p>
      <div className="settings-group">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="github_pat_..."
          autoComplete="off"
        />
        <label className="checkbox-label">
          <input type="checkbox" checked={persistToken} onChange={(event) => setPersistToken(event.target.checked)} />
          この端末に保存する（オフはセッション限定）
        </label>
        <div className="button-row">
          <button type="button" onClick={handleSaveToken}>保存</button>
          <button type="button" onClick={() => void handleTestConnection()} disabled={testing || token.trim() === ""}>
            {testing ? "確認中…" : "接続テスト"}
          </button>
        </div>
        {tokenMessage && <p className="notice">{tokenMessage}</p>}
      </div>

      <h2>学習</h2>
      <div className="settings-group">
        <span className="sheet-label">1日に出す新規カード</span>
        <div className="segmented">
          {NEW_CARDS_PER_DAY_OPTIONS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={newCardsPerDay === value}
              onClick={() => handleNewCardsPerDayChange(value)}
            >
              {value === 0 ? "無制限" : value}
            </button>
          ))}
        </div>
        <span className="sheet-label">この枚数を数える単位</span>
        <div className="segmented">
          <button type="button" aria-pressed={newCardsScope === "deck"} onClick={() => handleNewCardsScopeChange("deck")}>
            デッキごと
          </button>
          <button type="button" aria-pressed={newCardsScope === "all"} onClick={() => handleNewCardsScopeChange("all")}>
            全デッキ合計
          </button>
        </div>
        <p className="muted">
          {newCardsPerDay === 0
            ? "「無制限」を選んでいる間は、この単位の設定は効きません。"
            : newCardsScope === "deck"
              ? `デッキごとに1日 ${newCardsPerDay} 枚まで。${deckCount !== null ? `いまは ${deckCount} デッキあるので、全部開くと最大 ${newCardsPerDay * deckCount} 枚入ります。` : ""}新規は数日かけて復習が返ってくるので、毎日の復習が増えすぎるときは「全デッキ合計」にしてください。`
              : `全デッキ合わせて1日 ${newCardsPerDay} 枚まで。先に開いたデッキから枠を使います。`}
        </p>
        <span className="sheet-label">早押しの表示速度</span>
        <div className="segmented">
          {BUZZER_SPEEDS.map((speed) => (
            <button key={speed.ms} type="button" aria-pressed={buzzerSpeed === speed.ms} onClick={() => handleBuzzerSpeedChange(speed.ms)}>
              {speed.label}
            </button>
          ))}
        </div>
        <span className="sheet-label">右スワイプの評価に使う秒数</span>
        <p className="muted">
          問題が表示されてからスワイプするまでの時間で評価が決まります（答えを見ている時間も含みます）。この秒数より速ければその評価になります。
        </p>
        <div className="threshold-row">
          {([
            { key: "easy", label: "簡単" },
            { key: "good", label: "普通" },
            { key: "hard", label: "難しい" },
          ] as const).map(({ key, label }) => (
            <label key={key} className="threshold-field">
              {label}
              <input
                type="number"
                min={1}
                max={600}
                step={1}
                value={thresholds[key]}
                onChange={(event) => handleThresholdChange(key, event.target.value)}
                onBlur={handleThresholdBlur}
              />
            </label>
          ))}
        </div>
        <p className="muted">「難しい」の秒数を超えると「もう一度」になります。</p>
      </div>

      <h2>学習進捗のバックアップ</h2>
      <p className="muted">
        進捗はこの端末にのみ保存されます（ストレージ永続化: {usage === null ? "不明" : usage.persisted ? "有効" : "無効"}）。
        端末やブラウザのデータ削除に備えて、定期的に書き出してください。
        最終バックアップ: {lastBackupAt !== null ? formatTimestamp(lastBackupAt) : "未実施"}
      </p>
      {usage !== null && (
        <p className="muted">
          保存容量: {formatBytes(usage.usedBytes)}
          {usage.quotaBytes > 0 && ` / ${formatBytes(usage.quotaBytes)}`}
          （デッキのキャッシュと学習進捗の合計）
        </p>
      )}
      <div className="settings-group">
        <div className="button-row">
          <button type="button" onClick={() => void handleExport()}>JSONを書き出す</button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>JSONを取り込む</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.gz,application/json,application/gzip"
          className="hidden-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleImportFile(file);
            event.target.value = "";
          }}
        />
        {backupMessage && <p className="notice">{backupMessage}</p>}
      </div>

      <h2>GitHub へのバックアップ（{OWNER}/{BACKUP_REPOSITORY}）</h2>
      <p className="muted">
        非公開リポジトリの {BACKUP_PATH} に gzip で保存します。上のトークンに、このリポジトリも追加してください（Contents: Read and write）。
        GitHub への最終保存: {lastCloudBackupAt !== null ? formatTimestamp(lastCloudBackupAt) : "未実施"}
      </p>
      {cloudError && (
        <p className="notice warning">
          自動保存に失敗（{formatTimestamp(cloudError.at)}）: {cloudError.message}
        </p>
      )}
      <div className="settings-group">
        <label className="checkbox-label">
          <input type="checkbox" checked={autoCloud} onChange={(event) => handleAutoCloudChange(event.target.checked)} />
          学習を終えたとき自動で保存する（1日1回）
        </label>
        <div className="button-row">
          <button type="button" onClick={() => void handleCloudUpload()} disabled={cloudBusy || token.trim() === ""}>
            {cloudBusy ? "処理中…" : "今すぐ GitHub へ保存"}
          </button>
          <button type="button" onClick={() => void handleLoadCloudVersions()} disabled={cloudBusy || token.trim() === ""}>
            復元する版を選ぶ
          </button>
        </div>
        {cloudVersions !== null && cloudVersions.length > 0 && (
          <>
            <select value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)} aria-label="復元する版">
              <option value="main">最新</option>
              {cloudVersions.map((commit) => (
                <option key={commit.sha} value={commit.sha}>
                  {commit.date ? formatTimestamp(Date.parse(commit.date)) : commit.sha.slice(0, 7)} — {commit.message.split("\n")[0]}
                </option>
              ))}
            </select>
            <div className="button-row">
              <button type="button" onClick={() => void handleCloudRestore()} disabled={cloudBusy}>
                {cloudBusy ? "処理中…" : "この版を統合する"}
              </button>
            </div>
            <p className="muted">
              復元は上書きではなく統合です。端末側の方が新しい進捗はそのまま残り、端末で消した進捗が戻ることがあります。非表示の解除は戻りません。
            </p>
          </>
        )}
        {token.trim() === "" && <p className="muted">トークンを登録すると使えます。</p>}
        {cloudMessage && <p className="notice">{cloudMessage}</p>}
      </div>

      <h2>アニメーション</h2>
      <div className="settings-group">
        <label className="checkbox-label">
          <input type="checkbox" checked={crossfade} onChange={(event) => handleMotionChange(event.target.checked)} />
          動きを減らす（カードの反転・移動をクロスフェードにする）
        </label>
        <p className="muted">OS の「視差効果を減らす」設定に関係なく、この設定だけで切り替わります。</p>
      </div>

      <h2>メンテナンス</h2>
      <div className="settings-group">
        <div className="button-row">
          <button type="button" onClick={() => void handleDeleteOrphans()}>孤児進捗を削除</button>
        </div>
        <p className="muted">デッキから削除されたカードに残っている学習進捗を掃除します。</p>
        {orphanMessage && <p className="notice">{orphanMessage}</p>}
      </div>
    </section>
  );
}
