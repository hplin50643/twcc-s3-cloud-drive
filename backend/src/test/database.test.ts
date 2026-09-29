import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../database/database.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("adds an empty note to existing version 1 users", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "twcc-s3-migration-"));
    tempDirectories.push(directory);
    const file = path.join(directory, "app.sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-08-01T00:00:00.000Z');
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        s3_prefix TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users(username, password_hash, role, s3_prefix, created_at, updated_at)
      VALUES ('legacy-admin', 'hash', 'admin', 'uploads/', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    `);
    legacy.close();

    const database = new AppDatabase(file, "default-bucket");
    expect(database.getUserByUsername("legacy-admin")?.note).toBe("");
    expect(database.getUserByUsername("legacy-admin")?.s3Bucket).toBe("default-bucket");
    const user = database.getUserByUsername("legacy-admin")!;
    database.updateUserAccess(user.id, "admin", "uploads/", "Updated note");
    database.close();

    const reopened = new AppDatabase(file, "changed-default");
    expect(reopened.getUserById(user.id)?.s3Bucket).toBe("changed-default");
    expect(reopened.getUserById(user.id)?.note).toBe("Updated note");
    reopened.updateUserAccess(user.id, "admin", "uploads/", "Updated note", "custom-bucket");
    reopened.close();

    const configured = new AppDatabase(file, "another-default");
    expect(configured.getUserById(user.id)?.s3Bucket).toBe("custom-bucket");
    configured.close();
  });

  it("migrates version 2 accounts and preserves explicit buckets across restarts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "twcc-s3-migration-"));
    tempDirectories.push(directory);
    const file = path.join(directory, "app.sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (2, '2026-08-01T00:00:00.000Z');
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        s3_prefix TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users(username, password_hash, role, s3_prefix, note, created_at, updated_at)
      VALUES ('legacy-admin', 'hash', 'admin', 'uploads/', 'Keep this note', '2026-08-01', '2026-08-01');
    `);
    legacy.close();
    const database = new AppDatabase(file, "default-bucket");
    expect(database.listUsers()[0]).toMatchObject({ username: "legacy-admin", s3Bucket: "default-bucket", note: "Keep this note", s3Prefix: "uploads/" });
    const defaultUser = database.createUser({ username: "default-user", passwordHash: "hash", role: "user", s3Prefix: "data/" });
    const customUser = database.createUser({ username: "custom-user", passwordHash: "hash", role: "user", s3Bucket: "custom-bucket", s3Prefix: "data/" });
    database.close();
    const reopened = new AppDatabase(file, "changed-default");
    expect(reopened.getUserById(defaultUser.id)?.s3Bucket).toBe("default-bucket");
    expect(reopened.getUserById(customUser.id)?.s3Bucket).toBe("custom-bucket");
    expect(reopened.getUserByUsername("legacy-admin")?.s3Bucket).toBe("changed-default");
    reopened.close();
  });
});
