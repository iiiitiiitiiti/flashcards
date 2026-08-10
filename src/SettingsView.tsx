import { useEffect, useRef, useState } from "react";
import { exportBackup, importBackup } from "./backup";
import { deleteProgressByKeys, readAllProgress } from "./db";
import { testConnection } from "./github";
import { clearToken, loadLastBackupAt, loadMotionPreference, loadToken, saveLastBackupAt, saveMotionPreference, saveToken, tokenPersistence } from "./storage";
import type { DeckSnapshot } from "./types";

interface SettingsViewProps {
  snapshot: DeckSnapshot | null;
  onClose: () => void;
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SettingsView({ snapshot, onClose }: SettingsViewProps) {
  const [token, setToken] = useState(loadToken());
  const [persistToken, setPersistToken] = useState(tokenPersistence() !== "session");
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [storagePersisted, setStoragePersisted] = useState<boolean | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState(loadLastBackupAt());
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [orphanMessage, setOrphanMessage] = useState<string | null>(null);
  const [crossfade, setCrossfade] = useState(loadMotionPreference() === "crossfade");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleMotionChange(next: boolean) {
    setCrossfade(next);
    const preference = next ? "crossfade" : "full";
    saveMotionPreference(preference);
    document.documentElement.dataset.motion = preference;
  }

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setStoragePersisted).catch(() => setStoragePersisted(null));
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
      setTokenMessage(
        `接続成功: ${result.repository}（書き込み: ${result.writeAccess === "available" ? "可" : result.writeAccess === "unavailable" ? "不可" : "未確認"}）`,
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
      const backup = await exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date(backup.exportedAt).toISOString().slice(0, 10);
      anchor.href = url;
      anchor.download = `flashcards-backup-${stamp}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      saveLastBackupAt(backup.exportedAt);
      setLastBackupAt(backup.exportedAt);
      setBackupMessage(`進捗 ${backup.cardProgress.length} 件・ログ ${backup.reviewLog.length} 件を書き出しました。`);
    } catch (error) {
      setBackupMessage(error instanceof Error ? error.message : "エクスポートに失敗しました。");
    }
  }

  async function handleImportFile(file: File) {
    setBackupMessage(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await importBackup(parsed);
      setBackupMessage(`インポート完了: 進捗 ${result.progressImported} 件更新・${result.progressSkipped} 件スキップ・ログ ${result.logsImported} 件追加。`);
    } catch (error) {
      setBackupMessage(`インポート失敗（何も変更していません）: ${error instanceof Error ? error.message : "不明なエラー"}`);
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
      <header className="app-header">
        <h1>設定</h1>
        <button type="button" onClick={onClose}>戻る</button>
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

      <h2>学習進捗のバックアップ</h2>
      <p className="muted">
        進捗はこの端末にのみ保存されます（ストレージ永続化: {storagePersisted === null ? "不明" : storagePersisted ? "有効" : "無効"}）。
        端末やブラウザのデータ削除に備えて、定期的に書き出してください。
        最終バックアップ: {lastBackupAt !== null ? formatTimestamp(lastBackupAt) : "未実施"}
      </p>
      <div className="settings-group">
        <div className="button-row">
          <button type="button" onClick={() => void handleExport()}>JSONを書き出す</button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>JSONを取り込む</button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleImportFile(file);
            event.target.value = "";
          }}
        />
        {backupMessage && <p className="notice">{backupMessage}</p>}
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
