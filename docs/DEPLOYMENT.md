# Deployment And Operations

## First Deployment

```bash
cp .env.example .env
mkdir -p data
docker compose build
docker compose run --rm --no-deps backend npm run db:init -- \
  --username admin \
  --s3-prefix uploads/
docker compose up -d
```

`db:init` 會建立 schema 與第一位管理員。資料庫已有任何帳號時，初始化會拒絕執行；後續帳號請使用網頁管理介面。

第一位管理員使用 `.env` 的 `S3_BUCKET`，後續可從帳號管理設定個別 bucket。管理員可省略 `--s3-prefix` 以取得整個所選 bucket。非空白 prefix 必須至少包含一個 object 或 folder marker，否則初始化失敗。

`.env` 的 `S3_BUCKET` 仍為必要設定，作為新增帳號的預填值及未設定個別 bucket 的帳號預設值。各帳號的 bucket 必須位於相同的 `S3_ENDPOINT`，並可由共用的 S3 金鑰存取；金鑰需具備驗證 bucket、列出指定 prefix 與下載 object 的權限。

## Runtime Layout

```text
.env                    deployment secrets
data/app.sqlite         users, sessions and audit records
data/app.sqlite-wal     SQLite WAL while running
data/app.sqlite-shm     SQLite shared memory while running
```

Frontend 對外監聽 `${FRONTEND_PORT:-8080}`；backend 只有 `expose: 3000`，不映射到主機。`/api/v1/health` 回傳服務及初始化狀態。

## HTTPS

正式環境請在 compose frontend 前方配置 TLS reverse proxy，並傳遞 `Host`、`X-Forwarded-For` 與 `X-Forwarded-Proto: https`。確認 HTTPS 正常後設定：

```env
COOKIE_SECURE=true
TRUST_PROXY_HOPS=2
```

這會使用 `Secure`、`HttpOnly`、`SameSite=Strict` 及 `__Host-` Session cookie。直連 compose frontend 時只有 Nginx 一層 proxy，`TRUST_PROXY_HOPS=1`；前方另有一層 TLS proxy 時通常設為 `2`。數值必須等於實際可信任層數，避免錯記或信任偽造的來源 IP。直接使用 HTTP 測試時必須保持 `COOKIE_SECURE=false`，否則瀏覽器不會保存 Session。

## Backup

最簡單且一致的備份方式是短暫停止 backend：

```bash
docker compose stop backend
cp data/app.sqlite "data/app.sqlite.backup-$(date +%Y%m%d-%H%M%S)"
docker compose start backend
```

備份檔包含密碼雜湊、IP 與稽核紀錄，應使用受限制的目錄或加密備份。不要提交 GitHub。

## Restore

```bash
docker compose down
cp /secure/backup/app.sqlite data/app.sqlite
rm -f data/app.sqlite-wal data/app.sqlite-shm
docker compose up -d
```

還原後使用 `docker compose logs backend` 確認 schema migration 與健康檢查成功。

## Upgrade

```bash
docker compose stop backend
cp data/app.sqlite data/app.sqlite.before-upgrade
git pull --ff-only
docker compose up -d --build
docker compose ps
```

Backend 每次啟動會讀取 `schema_migrations` 並套用缺少的 migration。請先保留資料庫備份，再升級程式。

支援個別帳號 bucket 的版本會自動新增帳號的 bucket 欄位。既有帳號未儲存個別 bucket 設定前會沿用 `.env` 的 `S3_BUCKET`，無須手動修改資料庫。明確儲存 bucket 後，日後修改 `.env` 的預設值不會變更該帳號的 bucket。

## Troubleshooting

```bash
docker compose ps
docker compose logs --tail=200 backend
docker compose logs --tail=100 frontend
docker compose config
```

- `initialized: false`：尚未執行 `db:init`。
- Bucket 驗證失敗：檢查帳號設定的 bucket 是否存在，以及共用 endpoint、region、金鑰與 bucket 權限。權限不足或上游錯誤不代表 bucket 不存在。
- `Unable to validate the storage path`：檢查 endpoint、bucket、region、金鑰及 S3 權限。
- `The storage path does not exist`：該帳號所選 bucket 的 prefix 下沒有 object 或 folder marker。
- 登入後仍回登入頁：確認 `COOKIE_SECURE` 與實際 HTTP/HTTPS 模式一致。
- `database is locked`：確認只有同一個 compose deployment 使用該 bind mount，並檢查 `data/` 權限。
