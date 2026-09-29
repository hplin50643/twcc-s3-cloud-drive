# REST API

Base path：`/api/v1`。所有 response 使用 JSON，`204 No Content` 除外。瀏覽器必須保留 HTTP-only Session cookie。

## CSRF Flow

1. `GET /auth/csrf` 取得 `{ "csrfToken": "..." }` 並建立匿名 Session。
2. 所有 `POST`、`PATCH`、`DELETE` 請求加入 `X-CSRF-Token` header。
3. 登入成功會回傳新的 CSRF token；之後改用新 token。

Token 不應放在 URL、localStorage、log 或錯誤訊息。

## Authentication

```http
GET  /auth/csrf
POST /auth/login
GET  /auth/me
POST /auth/logout
POST /auth/change-password
```

登入 body：

```json
{ "username": "alice", "password": "example-password" }
```

成功 response：

```json
{
  "user": { "id": 1, "username": "alice", "role": "admin", "s3Bucket": "team-storage", "s3Prefix": "uploads/" },
  "csrfToken": "shortened-example"
}
```

更換密碼 body：

```json
{ "currentPassword": "current-example", "newPassword": "new-example" }
```

## Objects

```http
GET  /objects?prefix=&continuationToken=
POST /download-urls
POST /download-urls/batch
```

單檔 body：`{ "key": "reports/file.pdf" }`。

批量 body：

```json
{ "keys": ["file-a.pdf", "file-b.pdf"] }
```

批量下載接受 1–20 個 key，正規化後去除重複並維持輸入順序。任何 key 越界或任何 URL 產生失敗時，整批請求失敗。

列檔及下載均使用目前登入帳號設定的 bucket 與 prefix，這些 endpoints 不接受指定其他 bucket。登入與 `GET /auth/me` 回傳的 `user.s3Bucket` 為帳號目前實際使用的 bucket；未儲存個別設定時，回傳 `.env` 的 `S3_BUCKET`。

## Admin Users

以下 endpoints 需要 `admin`：

```http
GET    /admin/users
POST   /admin/users
PATCH  /admin/users/:id
DELETE /admin/users/:id
POST   /admin/users/:id/reset-password
POST   /admin/s3-buckets/validate
POST   /admin/s3-paths/validate
```

`GET /admin/users` 回傳：

```json
{
  "users": [
    {
      "id": 1,
      "username": "alice",
      "role": "admin",
      "s3Bucket": "team-storage",
      "s3Prefix": "uploads/",
      "note": "System owner",
      "createdAt": "2026-08-01T00:00:00.000Z",
      "updatedAt": "2026-08-01T00:00:00.000Z"
    }
  ],
  "defaultS3Bucket": "default-storage"
}
```

每位使用者的 `s3Bucket` 為目前實際使用的值；`defaultS3Bucket` 為 `.env` 的 `S3_BUCKET`，用於新增帳號的預填值。

建立帳號：

```json
{
  "username": "bob",
  "password": "example-password",
  "role": "user",
  "s3Bucket": "finance-storage",
  "s3Prefix": "uploads/bob/",
  "note": "Finance team contact"
}
```

更新權限與備註：

```json
{
  "role": "user",
  "s3Bucket": "finance-storage",
  "s3Prefix": "uploads/bob/",
  "note": "Primary finance team contact"
}
```

`note` 可為空字串，最多 1,000 字元。只有管理員帳號 API 會回傳備註；一般登入狀態與檔案 API 不會回傳。

建立帳號時可省略 `s3Bucket`，使用 `.env` 的 `S3_BUCKET`。更新帳號時省略 `s3Bucket`，保留既有設定。指定時應傳入 bucket 名稱，不能以 endpoint URL 或含有路徑的字串代替。新增及更新都會驗證所選 bucket 與其內的 prefix；一般使用者仍必須設定非空白 prefix。

重設密碼：`{ "password": "new-example" }`。

Bucket 驗證：

```http
POST /admin/s3-buckets/validate
```

```json
{ "s3Bucket": "finance-storage" }
```

回傳 `{ "s3Bucket": "finance-storage", "exists": true }`。若 S3 回報 bucket 不存在（`404`），驗證 endpoint 回傳成功 response 且 `exists` 為 `false`；權限不足或其他無法確認的上游錯誤回傳 `502`。

路徑驗證：

```http
POST /admin/s3-paths/validate
```

```json
{ "s3Bucket": "finance-storage", "s3Prefix": "uploads/bob/" }
```

回傳：

```json
{
  "s3Bucket": "finance-storage",
  "normalizedPrefix": "uploads/bob/",
  "exists": true,
  "wholeBucket": false
}
```

省略 `s3Bucket` 時使用 `.env` 的 `S3_BUCKET`。空白 prefix 的 `wholeBucket` 為 `true`，但仍需驗證 bucket 是否存在。

## Admin Audit

```http
GET /admin/audit/logins?limit=50&cursor=&username=
GET /admin/audit/downloads?limit=50&cursor=&username=
GET /admin/audit/admin-actions?limit=50&cursor=&username=
```

`limit` 為 1–100，預設 50。Response 格式：

```json
{
  "items": [],
  "nextCursor": null
}
```

有下一頁時，把 `nextCursor` 原值傳給下一次請求。紀錄固定由新到舊。

## Errors

```json
{
  "error": {
    "code": "S3_SCOPE_NOT_CONFIGURED",
    "message": "權限設定錯誤，請聯絡管理員。"
  }
}
```

常見狀態碼：`400` 驗證錯誤、`401` 未登入、`403` 權限或 CSRF、`409` 帳號/最後管理員衝突、`429` 登入限流、`502` S3 上游失敗。Response 不包含 stack、SDK 原始錯誤、S3 金鑰或環境變數。
