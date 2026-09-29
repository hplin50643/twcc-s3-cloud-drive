import { type FormEvent, useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Pencil, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import {
  createUser,
  deleteUser,
  listUsers,
  resetUserPassword,
  updateUser,
  validateS3Bucket,
  validateS3Path
} from "./api";
import { Modal } from "./Modal";
import type { AdminUser, User } from "./types";

type DialogState =
  | { type: "create" }
  | { type: "edit"; user: AdminUser }
  | { type: "reset"; user: AdminUser }
  | { type: "delete"; user: AdminUser }
  | null;

export function AdminUsersView({ currentUser, onSessionEnded }: { currentUser: User; onSessionEnded(): void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [defaultS3Bucket, setDefaultS3Bucket] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const result = await listUsers();
      setUsers(result.users);
      setDefaultS3Bucket(result.defaultS3Bucket);
    }
    catch (requestError) { setError(messageOf(requestError)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void reload(); }, []);
  const adminCount = users.filter((user) => user.role === "admin").length;

  async function handleCreate(input: AccountInput) {
    await createUser(input);
    setDialog(null);
    setStatus(`已新增帳號 ${input.username}。`);
    await reload();
  }

  async function handleEdit(target: AdminUser, input: AccountInput) {
    const result = await updateUser(target.id, { role: input.role, s3Bucket: input.s3Bucket, s3Prefix: input.s3Prefix, note: input.note });
    setDialog(null);
    if (result.signedOut) { onSessionEnded(); return; }
    setStatus(`已更新帳號 ${target.username}。`);
    await reload();
  }

  async function handleReset(target: AdminUser, password: string) {
    const result = await resetUserPassword(target.id, password);
    setDialog(null);
    if (result.signedOut) { onSessionEnded(); return; }
    setStatus(`已重設 ${target.username} 的密碼。`);
  }

  async function handleDelete(target: AdminUser) {
    const result = await deleteUser(target.id);
    setDialog(null);
    if (result.signedOut) { onSessionEnded(); return; }
    setStatus(`已刪除帳號 ${target.username}。`);
    await reload();
  }

  return (
    <section className="management-view" aria-labelledby="users-title">
      <div className="section-heading">
        <div><h2 id="users-title">帳號管理</h2><p>{users.length} 個帳號，{adminCount} 位管理員</p></div>
        <button className="primary-action text-button" type="button" disabled={loading || !defaultS3Bucket} onClick={() => setDialog({ type: "create" })}>
          <Plus size={18} aria-hidden="true" />新增帳號
        </button>
      </div>
      {error ? <div className="status-error inline-status">{error}</div> : null}
      {status ? <div className="status-success inline-status" role="status">{status}</div> : null}
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>帳號</th><th>角色</th><th>S3 Bucket</th><th>S3 路徑</th><th>備註</th><th>建立時間</th><th>操作</th></tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={7} className="table-message">載入中</td></tr> : null}
            {!loading && users.length === 0 ? <tr><td colSpan={7} className="table-message">尚無帳號</td></tr> : null}
            {!loading ? users.map((user) => {
              const finalAdmin = user.role === "admin" && adminCount === 1;
              return (
                <tr key={user.id}>
                  <td data-label="帳號"><strong>{user.username}</strong>{user.id === currentUser.id ? <span className="self-label">目前帳號</span> : null}</td>
                  <td data-label="角色"><span className={`role-badge ${user.role}`}>{user.role === "admin" ? "管理員" : "使用者"}</span></td>
                  <td data-label="S3 Bucket" className="path-value">{user.s3Bucket}</td>
                  <td data-label="S3 路徑" className="path-value">{user.s3Prefix || "整個 bucket"}</td>
                  <td data-label="備註" className="account-note">{user.note || "-"}</td>
                  <td data-label="建立時間">{formatTimestamp(user.createdAt)}</td>
                  <td data-label="操作"><div className="row-actions">
                    <button className="icon-button" type="button" onClick={() => setDialog({ type: "edit", user })} title="編輯" aria-label={`編輯 ${user.username}`}><Pencil size={17} /></button>
                    <button className="icon-button" type="button" onClick={() => setDialog({ type: "reset", user })} title="重設密碼" aria-label={`重設 ${user.username} 密碼`}><KeyRound size={17} /></button>
                    <button className="icon-button danger-button" type="button" disabled={finalAdmin} onClick={() => setDialog({ type: "delete", user })} title={finalAdmin ? "無法刪除最後一位管理員" : "刪除"} aria-label={`刪除 ${user.username}`}><Trash2 size={17} /></button>
                  </div></td>
                </tr>
              );
            }) : null}
          </tbody>
        </table>
      </div>

      {dialog?.type === "create" ? <AccountDialog mode="create" defaultS3Bucket={defaultS3Bucket} onClose={() => setDialog(null)} onSubmit={handleCreate} /> : null}
      {dialog?.type === "edit" ? <AccountDialog mode="edit" defaultS3Bucket={defaultS3Bucket} user={dialog.user} canDemote={!(dialog.user.role === "admin" && adminCount === 1)} onClose={() => setDialog(null)} onSubmit={(input) => handleEdit(dialog.user, input)} /> : null}
      {dialog?.type === "reset" ? <PasswordDialog user={dialog.user} onClose={() => setDialog(null)} onSubmit={(password) => handleReset(dialog.user, password)} /> : null}
      {dialog?.type === "delete" ? <DeleteDialog user={dialog.user} onClose={() => setDialog(null)} onConfirm={() => handleDelete(dialog.user)} /> : null}
    </section>
  );
}

interface AccountInput { username: string; password: string; role: User["role"]; s3Bucket: string; s3Prefix: string; note: string; }
interface ValidationResult { message: string; exists: boolean; }

function AccountDialog({ mode, user, defaultS3Bucket, canDemote = true, onClose, onSubmit }: {
  mode: "create" | "edit";
  user?: AdminUser;
  defaultS3Bucket: string;
  canDemote?: boolean;
  onClose(): void;
  onSubmit(input: AccountInput): Promise<void>;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [role, setRole] = useState<User["role"]>(user?.role ?? "user");
  const [s3Bucket, setS3Bucket] = useState(user?.s3Bucket ?? defaultS3Bucket);
  const [s3Prefix, setS3Prefix] = useState(user?.s3Prefix ?? "uploads/");
  const [note, setNote] = useState(user?.note ?? "");
  const [bucketValidation, setBucketValidation] = useState<ValidationResult | null>(null);
  const [pathValidation, setPathValidation] = useState<ValidationResult | null>(null);
  const [checkingBucket, setCheckingBucket] = useState(false);
  const [checkingPath, setCheckingPath] = useState(false);
  const bucketRequest = useRef(0);
  const pathRequest = useRef(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => () => { bucketRequest.current++; pathRequest.current++; }, []);

  function clearPathValidation() {
    pathRequest.current++;
    setCheckingPath(false);
    setPathValidation(null);
    setError("");
  }

  function changeBucket(value: string) {
    bucketRequest.current++;
    setCheckingBucket(false);
    setBucketValidation(null);
    clearPathValidation();
    setS3Bucket(value);
  }

  async function checkBucket() {
    const request = ++bucketRequest.current;
    setError(""); setBucketValidation(null);
    if (!s3Bucket.trim()) {
      setBucketValidation({ message: "請設定 S3 Bucket。", exists: false });
      return;
    }
    setCheckingBucket(true);
    try {
      const result = await validateS3Bucket(s3Bucket);
      if (request !== bucketRequest.current) return;
      setS3Bucket(result.s3Bucket);
      setBucketValidation({ message: result.exists ? "S3 Bucket 存在。" : "S3 Bucket 不存在。", exists: result.exists });
    } catch (requestError) {
      if (request === bucketRequest.current) setBucketValidation({ message: messageOf(requestError), exists: false });
    } finally {
      if (request === bucketRequest.current) setCheckingBucket(false);
    }
  }

  async function checkPath() {
    const request = ++pathRequest.current;
    setError(""); setPathValidation(null);
    if (!s3Bucket.trim()) {
      setPathValidation({ message: "請先設定 S3 Bucket。", exists: false });
      return;
    }
    if (role === "user" && s3Prefix.trim() === "") {
      setPathValidation({ message: "一般使用者必須設定 S3 路徑。", exists: false });
      return;
    }
    setCheckingPath(true);
    try {
      const result = await validateS3Path(s3Prefix, s3Bucket);
      if (request !== pathRequest.current) return;
      setS3Prefix(result.normalizedPrefix);
      setPathValidation({ message: result.exists ? (result.wholeBucket ? "可存取整個 bucket。" : "路徑存在。") : "路徑不存在。", exists: result.exists });
    } catch (requestError) {
      if (request === pathRequest.current) setPathValidation({ message: messageOf(requestError), exists: false });
    } finally {
      if (request === pathRequest.current) setCheckingPath(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (mode === "create" && password !== confirmation) { setError("兩次輸入的密碼不一致。"); return; }
    if (!s3Bucket.trim()) { setError("請設定 S3 Bucket。"); return; }
    if (role === "user" && s3Prefix.trim() === "") { setError("一般使用者必須設定 S3 路徑。"); return; }
    setBusy(true);
    try { await onSubmit({ username, password, role, s3Bucket, s3Prefix, note }); }
    catch (requestError) { setError(messageOf(requestError)); }
    finally { setBusy(false); }
  }

  return (
    <Modal title={mode === "create" ? "新增帳號" : `編輯 ${user?.username}`} onClose={onClose}>
      <form className="management-form" onSubmit={submit}>
        <label>帳號<input value={username} onChange={(event) => setUsername(event.target.value)} disabled={mode === "edit"} autoComplete="off" required /></label>
        {mode === "create" ? <>
          <label>密碼<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></label>
          <label>確認密碼<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required /></label>
        </> : null}
        <label>角色<select value={role} onChange={(event) => { setRole(event.target.value as User["role"]); clearPathValidation(); }}>
          <option value="admin">管理員</option>
          <option value="user" disabled={!canDemote}>使用者</option>
        </select></label>
        <div className="storage-field"><label htmlFor="account-s3-bucket">S3 Bucket</label><div className="path-input-row"><input id="account-s3-bucket" value={s3Bucket} onChange={(event) => changeBucket(event.target.value)} required /><button className="icon-button" type="button" disabled={checkingBucket} onClick={() => void checkBucket()} title="驗證 Bucket" aria-label="驗證 Bucket"><ShieldCheck size={18} /></button></div></div>
        {checkingBucket ? <div role="status">正在驗證 S3 Bucket…</div> : null}
        {bucketValidation ? <div className={bucketValidation.exists ? "validation-success" : "form-error"} role="status">{bucketValidation.exists ? <CheckCircle2 size={17} /> : null}{bucketValidation.message}</div> : null}
        <div className="storage-field"><label htmlFor="account-s3-prefix">S3 路徑</label><div className="path-input-row"><input id="account-s3-prefix" value={s3Prefix} onChange={(event) => { setS3Prefix(event.target.value); clearPathValidation(); }} placeholder={role === "admin" ? "空白代表整個 bucket" : "uploads/"} /><button className="icon-button" type="button" disabled={checkingPath} onClick={() => void checkPath()} title="驗證路徑" aria-label="驗證路徑"><ShieldCheck size={18} /></button></div></div>
        {checkingPath ? <div role="status">正在驗證路徑…</div> : null}
        {pathValidation ? <div className={pathValidation.exists ? "validation-success" : "form-error"} role="status">{pathValidation.exists ? <CheckCircle2 size={17} /> : null}{pathValidation.message}</div> : null}
        <label>備註（選填）<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1_000} rows={4} /></label>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="form-actions"><button className="secondary-action" type="button" onClick={onClose}>取消</button><button className="primary-action text-button" type="submit" disabled={busy}><Save size={17} />{busy ? "儲存中" : "儲存"}</button></div>
      </form>
    </Modal>
  );
}

function PasswordDialog({ user, onClose, onSubmit }: { user: AdminUser; onClose(): void; onSubmit(password: string): Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (password !== confirmation) { setError("兩次輸入的密碼不一致。"); return; }
    setBusy(true);
    try { await onSubmit(password); } catch (requestError) { setError(messageOf(requestError)); } finally { setBusy(false); }
  }
  return <Modal title={`重設 ${user.username} 密碼`} onClose={onClose}><form className="management-form" onSubmit={submit}>
    <label>新密碼<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required /></label>
    <label>確認新密碼<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required /></label>
    {error ? <div className="form-error">{error}</div> : null}
    <div className="form-actions"><button className="secondary-action" type="button" onClick={onClose}>取消</button><button className="primary-action text-button" type="submit" disabled={busy}><KeyRound size={17} />{busy ? "重設中" : "重設密碼"}</button></div>
  </form></Modal>;
}

function DeleteDialog({ user, onClose, onConfirm }: { user: AdminUser; onClose(): void; onConfirm(): Promise<void> }) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function confirm() { setBusy(true); setError(""); try { await onConfirm(); } catch (requestError) { setError(messageOf(requestError)); setBusy(false); } }
  return <Modal title="刪除帳號" onClose={onClose}><div className="confirm-content"><p>確定要刪除 <strong>{user.username}</strong>？歷史稽核紀錄仍會保留。</p>{error ? <div className="form-error">{error}</div> : null}<div className="form-actions"><button className="secondary-action" type="button" onClick={onClose}>取消</button><button className="danger-action" type="button" disabled={busy} onClick={() => void confirm()}><Trash2 size={17} />{busy ? "刪除中" : "刪除帳號"}</button></div></div></Modal>;
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Request failed."; }
function formatTimestamp(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
