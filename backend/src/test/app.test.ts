import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { PasswordHasher } from "../auth/passwords.js";
import { createApp } from "../app.js";
import { AppDatabase } from "../database/database.js";
import type { ObjectListResult, StorageAdminClient, UserRole } from "../types.js";

class FakePasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    if (!password) throw new Error("EMPTY_PASSWORD");
    return `test:${password}`;
  }
  async verify(passwordHash: string, password: string): Promise<boolean> {
    return passwordHash === `test:${password}`;
  }
}

class MockStorage implements StorageAdminClient {
  listError: Error | null = null;
  downloadError: Error | null = null;
  downloadKeys: string[] = [];
  prefixesChecked: string[] = [];
  listedBuckets: Array<string | undefined> = [];
  downloadBuckets: Array<string | undefined> = [];
  checkedPaths: Array<{ prefix: string; bucket: string | undefined }> = [];
  bucketsChecked: string[] = [];

  async listObjects(input: { prefix: string; continuationToken?: string; bucket?: string }): Promise<ObjectListResult> {
    this.listedBuckets.push(input.bucket);
    if (this.listError) throw this.listError;
    return {
      prefix: input.prefix,
      folders: [{ name: "reports", prefix: `${input.prefix}reports/` }],
      files: [{
        key: `${input.prefix}readme.txt`,
        name: "readme.txt",
        size: 42,
        lastModified: "2026-07-14T00:00:00.000Z"
      }],
      nextContinuationToken: null
    };
  }

  async createDownloadUrl(input: { key: string; expiresInSeconds: number; bucket?: string }): Promise<string> {
    if (this.downloadError) throw this.downloadError;
    this.downloadKeys.push(input.key);
    this.downloadBuckets.push(input.bucket);
    return `https://storage.example.test/${encodeURIComponent(input.key)}?signature=short`;
  }

  async bucketExists(bucket: string): Promise<boolean> {
    this.bucketsChecked.push(bucket);
    if (bucket === "inaccessible-bucket") throw new Error("S3_BUCKET_CHECK_FAILED");
    return bucket !== "missing-bucket";
  }

  async prefixExists(prefix: string, bucket?: string): Promise<boolean> {
    this.prefixesChecked.push(prefix);
    this.checkedPaths.push({ prefix, bucket });
    if (prefix === "error/") throw new Error("S3_PATH_CHECK_FAILED");
    return prefix !== "missing/" && (prefix !== "exclusive/" || bucket === "other-bucket");
  }
}

interface TestContext {
  app: ReturnType<typeof createApp>;
  database: AppDatabase;
  storage: MockStorage;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(overrides: { usernameLimit?: number; ipLimit?: number } = {}): Promise<TestContext> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "twcc-s3-db-"));
  const database = new AppDatabase(path.join(tempDir, "app.sqlite"), "default-bucket");
  const passwordHasher = new FakePasswordHasher();
  database.createUser({ username: "alice", passwordHash: await passwordHasher.hash("password-one"), role: "admin", s3Prefix: "uploads/" });
  database.createUser({ username: "bob", passwordHash: await passwordHasher.hash("password-two"), role: "user", s3Prefix: "clients/bob/" });
  const storage = new MockStorage();
  const app = createApp({
    config: {
      NODE_ENV: "test",
      TRUST_PROXY_HOPS: 1,
      SESSION_SECRET: "test-session-secret-at-least-24-chars",
      COOKIE_SECURE: false,
      SESSION_IDLE_MINUTES: 60,
      SESSION_ABSOLUTE_HOURS: 12,
      LOGIN_RATE_LIMIT_WINDOW_MINUTES: 15,
      LOGIN_RATE_LIMIT_PER_USERNAME: overrides.usernameLimit ?? 10,
      LOGIN_RATE_LIMIT_PER_IP: overrides.ipLimit ?? 30,
      SIGNED_URL_EXPIRES_SECONDS: 300,
      S3_BUCKET: "default-bucket"
    },
    database,
    passwordHasher,
    storage
  });
  const context = { app, database, storage, tempDir };
  contexts.push(context);
  return context;
}

type Agent = ReturnType<typeof request.agent>;

async function csrf(agent: Agent): Promise<string> {
  const response = await agent.get("/api/v1/auth/csrf");
  expect(response.status).toBe(200);
  return response.body.csrfToken as string;
}

async function login(agent: Agent, username: string, password: string, ip = "203.0.113.10"): Promise<string> {
  const token = await csrf(agent);
  const response = await agent
    .post("/api/v1/auth/login")
    .set("X-CSRF-Token", token)
    .set("X-Forwarded-For", ip)
    .send({ username, password });
  expect(response.status).toBe(200);
  return response.body.csrfToken as string;
}

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    context.database.close();
    await fs.rm(context.tempDir, { recursive: true, force: true });
  }
});

describe("authentication and sessions", () => {
  it("requires CSRF for login and accepts multiple SQLite users", async () => {
    const { app } = await createTestContext();
    expect((await request(app).post("/api/v1/auth/login").send({ username: "alice", password: "password-one" })).status).toBe(403);
    await login(request.agent(app), "alice", "password-one");
    await login(request.agent(app), "bob", "password-two");
  });

  it("records successful and failed logins with the forwarded IP", async () => {
    const { app, database } = await createTestContext();
    const failedAgent = request.agent(app);
    const failedToken = await csrf(failedAgent);
    const failed = await failedAgent.post("/api/v1/auth/login").set("X-CSRF-Token", failedToken).set("X-Forwarded-For", "198.51.100.7").send({ username: "bob", password: "wrong" });
    expect(failed.status).toBe(401);
    await login(request.agent(app), "alice", "password-one", "198.51.100.8");
    const events = database.listLoginEvents({ limit: 10 });
    expect(events.items.map((item) => item.outcome)).toEqual(["success", "failure"]);
    expect(events.items[1].ipAddress).toBe("198.51.100.7");
  });

  it("limits failures separately by username", async () => {
    const { app, database } = await createTestContext({ usernameLimit: 1 });
    const agent = request.agent(app);
    const token = await csrf(agent);
    expect((await agent.post("/api/v1/auth/login").set("X-CSRF-Token", token).send({ username: "bob", password: "wrong" })).status).toBe(401);
    expect((await agent.post("/api/v1/auth/login").set("X-CSRF-Token", token).send({ username: "bob", password: "wrong-again" })).status).toBe(429);
    expect(database.listLoginEvents({ limit: 10 }).items[0].outcome).toBe("rate_limited");
  });

  it("changes a password and invalidates every existing session", async () => {
    const { app, database } = await createTestContext();
    const first = request.agent(app);
    const second = request.agent(app);
    const firstToken = await login(first, "bob", "password-two");
    await login(second, "bob", "password-two");
    const changed = await first.post("/api/v1/auth/change-password").set("X-CSRF-Token", firstToken).send({ currentPassword: "password-two", newPassword: "新密碼 with spaces" });
    expect(changed.status).toBe(204);
    expect((await first.get("/api/v1/auth/me")).status).toBe(401);
    expect((await second.get("/api/v1/auth/me")).status).toBe(401);
    expect(database.getUserByUsername("bob")?.passwordHash).toBe("test:新密碼 with spaces");
  });
});

describe("scoped objects and download audit", () => {
  it("uses each account's bucket for listing, single and batch downloads and ignores request bucket overrides", async () => {
    const { app, storage, database } = await createTestContext();
    const bobUser = database.getUserByUsername("bob")!;
    database.updateUserAccess(bobUser.id, "user", bobUser.s3Prefix, "", "bob-bucket");
    const alice = request.agent(app);
    const bob = request.agent(app);
    const aliceToken = await login(alice, "alice", "password-one");
    const bobToken = await login(bob, "bob", "password-two");
    expect((await bob.get("/api/v1/auth/me")).body.user.s3Bucket).toBe("bob-bucket");
    const results = await Promise.all([
      alice.get("/api/v1/objects?s3Bucket=untrusted-bucket&bucket=untrusted-bucket"),
      bob.get("/api/v1/objects?s3Bucket=untrusted-bucket&bucket=untrusted-bucket")
    ]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(storage.listedBuckets.sort()).toEqual(["bob-bucket", "default-bucket"]);
    expect((await bob.post("/api/v1/download-urls").set("X-CSRF-Token", bobToken).send({ key: "readme.txt", bucket: "default-bucket", s3Bucket: "default-bucket" })).status).toBe(200);
    expect((await alice.post("/api/v1/download-urls/batch").set("X-CSRF-Token", aliceToken).send({ keys: ["one.txt", "two.txt"], bucket: "bob-bucket", s3Bucket: "bob-bucket" })).status).toBe(200);
    expect(storage.downloadBuckets).toEqual(["bob-bucket", "default-bucket", "default-bucket"]);

    const changed = await alice.patch(`/api/v1/admin/users/${bobUser.id}`).set("X-CSRF-Token", aliceToken).send({ role: "user", s3Prefix: "new-scope/", s3Bucket: "changed-bucket" });
    expect(changed.status).toBe(200);
    expect((await bob.get("/api/v1/auth/me")).body.user.s3Bucket).toBe("changed-bucket");
    expect((await bob.get("/api/v1/objects")).status).toBe(200);
    expect(storage.listedBuckets.at(-1)).toBe("changed-bucket");
    expect((await bob.post("/api/v1/download-urls").set("X-CSRF-Token", bobToken).send({ key: "readme.txt" })).status).toBe(200);
    expect(storage.downloadBuckets.at(-1)).toBe("changed-bucket");
    expect(storage.downloadKeys.at(-1)).toBe("new-scope/readme.txt");
  });

  it("uses the current user's S3 prefix and records issued URLs", async () => {
    const { app, storage, database } = await createTestContext();
    const agent = request.agent(app);
    const token = await login(agent, "bob", "password-two");
    const listing = await agent.get("/api/v1/objects");
    expect(listing.body.files[0].key).toBe("readme.txt");
    const download = await agent.post("/api/v1/download-urls").set("X-CSRF-Token", token).send({ key: "readme.txt" });
    expect(download.status).toBe(200);
    expect(storage.downloadKeys).toEqual(["clients/bob/readme.txt"]);
    expect(database.listDownloadEvents({ limit: 10 }).items[0].objectKey).toBe("clients/bob/readme.txt");
  });

  it("creates ordered batch URLs, removes duplicates, and blocks traversal", async () => {
    const { app, storage, database } = await createTestContext();
    const agent = request.agent(app);
    const token = await login(agent, "alice", "password-one");
    const response = await agent.post("/api/v1/download-urls/batch").set("X-CSRF-Token", token).send({ keys: ["new.txt", "/old.txt", "new.txt"] });
    expect(response.status).toBe(200);
    expect(storage.downloadKeys).toEqual(["uploads/new.txt", "uploads/old.txt"]);
    expect(database.listDownloadEvents({ limit: 10 }).items).toHaveLength(2);
    const traversal = await agent.post("/api/v1/download-urls/batch").set("X-CSRF-Token", token).send({ keys: ["safe.txt", "../private.txt"] });
    expect(traversal.status).toBe(400);
  });

  it("returns the configured permission error for an unscoped regular user", async () => {
    const { app, database } = await createTestContext();
    database.createUser({ username: "broken", passwordHash: "test:password", role: "user", s3Prefix: "" });
    const agent = request.agent(app);
    await login(agent, "broken", "password");
    const response = await agent.get("/api/v1/objects");
    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe("權限設定錯誤，請聯絡管理員。");
  });
});

describe("administrator APIs", () => {
  it("exposes the configured default and saves a distinct bucket per account", async () => {
    const { app, storage, database } = await createTestContext();
    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    const users = await admin.get("/api/v1/admin/users");
    expect(users.body.defaultS3Bucket).toBe("default-bucket");
    expect(users.body.users.every((user: { s3Bucket: string }) => user.s3Bucket === "default-bucket")).toBe(true);

    const created = await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({
      username: "carol", password: "pass", role: "user", s3Bucket: " other-bucket ", s3Prefix: "exclusive/"
    });
    expect(created.status).toBe(201);
    expect(created.body.user.s3Bucket).toBe("other-bucket");
    expect(database.getUserByUsername("carol")?.s3Bucket).toBe("other-bucket");
    expect(storage.checkedPaths).toContainEqual({ bucket: "other-bucket", prefix: "exclusive/" });

    const edited = await admin.patch(`/api/v1/admin/users/${created.body.user.id}`).set("X-CSRF-Token", token).send({
      role: "user", s3Prefix: "exclusive/", note: "Retain bucket on older API clients"
    });
    expect(edited.status).toBe(200);
    expect(edited.body.user.s3Bucket).toBe("other-bucket");
    const actions = database.listAdminEvents({ limit: 10 }).items;
    expect(actions[0].details).toMatchObject({ previousS3Bucket: "other-bucket", s3Bucket: "other-bucket" });
    expect(actions[1].details).toMatchObject({ s3Bucket: "other-bucket" });
  });

  it("checks buckets and paths in the selected bucket, and distinguishes absence from failed checks", async () => {
    const { app, storage } = await createTestContext();
    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    const validateBucket = (s3Bucket: unknown) => admin.post("/api/v1/admin/s3-buckets/validate").set("X-CSRF-Token", token).send({ s3Bucket });
    expect((await validateBucket("other-bucket")).body).toEqual({ s3Bucket: "other-bucket", exists: true });
    expect((await validateBucket("missing-bucket")).body.exists).toBe(false);
    const failure = await validateBucket("inaccessible-bucket");
    expect(failure.status).toBe(502);
    expect(failure.body.error.code).toBe("S3_BUCKET_CHECK_FAILED");
    for (const invalid of ["", "../other", "https://other-bucket", "bad bucket", "a..b", 42]) {
      const result = await validateBucket(invalid);
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("INVALID_S3_BUCKET");
    }
    expect(storage.bucketsChecked).toEqual(["other-bucket", "missing-bucket", "inaccessible-bucket"]);

    const pathInOther = await admin.post("/api/v1/admin/s3-paths/validate").set("X-CSRF-Token", token).send({ s3Bucket: "other-bucket", s3Prefix: "exclusive" });
    expect(pathInOther.body).toMatchObject({ s3Bucket: "other-bucket", normalizedPrefix: "exclusive/", exists: true });
    const pathInDefault = await admin.post("/api/v1/admin/s3-paths/validate").set("X-CSRF-Token", token).send({ s3Prefix: "exclusive" });
    expect(pathInDefault.body).toMatchObject({ s3Bucket: "default-bucket", exists: false });
    const root = await admin.post("/api/v1/admin/s3-paths/validate").set("X-CSRF-Token", token).send({ s3Bucket: "other-bucket", s3Prefix: "" });
    expect(root.body).toMatchObject({ exists: true, wholeBucket: true });
  });

  it("rejects invalid bucket assignments and validates the path again when the bucket changes", async () => {
    const { app, database } = await createTestContext();
    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    for (const [s3Bucket, code] of [["", "INVALID_S3_BUCKET"], ["missing-bucket", "S3_BUCKET_NOT_FOUND"], ["inaccessible-bucket", "S3_BUCKET_CHECK_FAILED"]]) {
      const result = await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({ username: "carol", password: "pass", role: "admin", s3Bucket, s3Prefix: "" });
      expect(result.body.error.code).toBe(code);
      expect(database.getUserByUsername("carol")).toBeNull();
    }
    const carol = database.createUser({ username: "carol", passwordHash: "test:pass", role: "user", s3Bucket: "other-bucket", s3Prefix: "exclusive/" });
    const changed = await admin.patch(`/api/v1/admin/users/${carol.id}`).set("X-CSRF-Token", token).send({ role: "user", s3Bucket: "default-bucket", s3Prefix: "exclusive/" });
    expect(changed.body.error.code).toBe("S3_PATH_NOT_FOUND");
    expect(database.getUserById(carol.id)?.s3Bucket).toBe("other-bucket");
  });

  it("protects bucket validation with authentication, administrator access and CSRF", async () => {
    const { app } = await createTestContext();
    const anonymous = request.agent(app);
    const anonymousToken = await csrf(anonymous);
    expect((await anonymous.post("/api/v1/admin/s3-buckets/validate").set("X-CSRF-Token", anonymousToken).send({ s3Bucket: "other-bucket" })).status).toBe(401);
    const bob = request.agent(app);
    const bobToken = await login(bob, "bob", "password-two");
    expect((await bob.post("/api/v1/admin/s3-buckets/validate").set("X-CSRF-Token", bobToken).send({ s3Bucket: "other-bucket" })).status).toBe(403);
    const admin = request.agent(app);
    await login(admin, "alice", "password-one");
    expect((await admin.post("/api/v1/admin/s3-buckets/validate").send({ s3Bucket: "other-bucket" })).status).toBe(403);
  });

  it("blocks regular users and lets admins create and edit a noted scoped account", async () => {
    const { app, storage, database } = await createTestContext();
    const bob = request.agent(app);
    await login(bob, "bob", "password-two");
    expect((await bob.get("/api/v1/admin/users")).status).toBe(403);

    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    const created = await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({ username: "carol", password: "", role: "user", s3Prefix: "clients/carol/" });
    expect(created.status).toBe(400);
    const valid = await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({ username: "carol", password: "pass", role: "user", s3Prefix: "/clients/carol", note: "Finance contact\nWeekdays only" });
    expect(valid.status).toBe(201);
    expect(valid.body.user.s3Prefix).toBe("clients/carol/");
    expect(valid.body.user.s3Bucket).toBe("default-bucket");
    expect(valid.body.user.note).toBe("Finance contact\nWeekdays only");
    expect(storage.prefixesChecked).toContain("clients/carol/");

    const updated = await admin.patch(`/api/v1/admin/users/${valid.body.user.id}`).set("X-CSRF-Token", token).send({
      role: "user",
      s3Prefix: "clients/carol/",
      note: "Primary finance contact"
    });
    expect(updated.status).toBe(200);
    expect(updated.body.user.note).toBe("Primary finance contact");
    expect(database.getUserByUsername("carol")?.note).toBe("Primary finance contact");
  });

  it("rejects missing paths for users and nonexistent prefixes", async () => {
    const { app } = await createTestContext();
    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    expect((await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({ username: "empty", password: "pass", role: "user", s3Prefix: "" })).body.error.code).toBe("S3_SCOPE_REQUIRED");
    expect((await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({ username: "missing", password: "pass", role: "user", s3Prefix: "missing/" })).body.error.code).toBe("S3_PATH_NOT_FOUND");
  });

  it("protects the final administrator from deletion and demotion", async () => {
    const { app, database } = await createTestContext();
    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    const alice = database.getUserByUsername("alice")!;
    const deletion = await admin.delete(`/api/v1/admin/users/${alice.id}`).set("X-CSRF-Token", token);
    expect(deletion.status).toBe(409);
    const demotion = await admin.patch(`/api/v1/admin/users/${alice.id}`).set("X-CSRF-Token", token).send({ role: "user" satisfies UserRole, s3Prefix: "uploads/" });
    expect(demotion.status).toBe(409);
  });

  it("returns audit records newest first and records management actions", async () => {
    const { app } = await createTestContext();
    const admin = request.agent(app);
    const token = await login(admin, "alice", "password-one");
    await admin.post("/api/v1/admin/users").set("X-CSRF-Token", token).send({ username: "carol", password: "pass", role: "admin", s3Prefix: "" });
    const response = await admin.get("/api/v1/admin/audit/admin-actions");
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ action: "user.created", targetUsername: "carol" });
  });
});

describe("retention and error safety", () => {
  it("purges expired audit rows", async () => {
    const { database } = await createTestContext();
    database.recordLogin({ userId: null, username: "old", outcome: "failure", ipAddress: "127.0.0.1" });
    expect(database.purgeAuditBefore(new Date(Date.now() + 1_000).toISOString())).toBe(1);
    expect(database.listLoginEvents({ limit: 10 }).items).toHaveLength(0);
  });

  it("does not leak sensitive storage errors", async () => {
    const { app, storage } = await createTestContext();
    const agent = request.agent(app);
    await login(agent, "alice", "password-one");
    storage.listError = new Error("S3_LIST_FAILED with AKIASECRET and SECRET_ACCESS_KEY");
    const response = await agent.get("/api/v1/objects");
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("AKIASECRET");
  });
});
