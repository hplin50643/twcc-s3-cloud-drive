import { describe, expect, it } from "vitest";
import { ScopedStorage, normalizeRootPrefix } from "../storage/scopedStorage.js";
import type { ObjectListResult, StorageClient } from "../types.js";

class RecordingStorage implements StorageClient {
  listInput: { prefix: string; continuationToken?: string; bucket?: string } | null = null;
  downloadInput: { key: string; expiresInSeconds: number; bucket?: string } | null = null;

  async listObjects(input: {
    prefix: string;
    continuationToken?: string;
    bucket?: string;
  }): Promise<ObjectListResult> {
    this.listInput = input;
    return {
      prefix: input.prefix,
      folders: [{ name: "reports", prefix: "uploads/reports/" }],
      files: [
        {
          key: "uploads/readme.txt",
          name: "readme.txt",
          size: 42,
          lastModified: null
        },
        {
          key: "private/hidden.txt",
          name: "hidden.txt",
          size: 1,
          lastModified: null
        }
      ],
      nextContinuationToken: null
    };
  }

  async createDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    bucket?: string;
  }): Promise<string> {
    this.downloadInput = input;
    return "https://storage.example.test/signed";
  }
}

describe("ScopedStorage", () => {
  it("normalizes the configured root prefix", () => {
    expect(normalizeRootPrefix("/uploads\\public")).toBe("uploads/public/");
  });

  it("lists only within the root and returns relative paths", async () => {
    const inner = new RecordingStorage();
    const storage = new ScopedStorage(inner, "uploads/");

    const result = await storage.listObjects({ prefix: "", continuationToken: "next" });

    expect(inner.listInput).toEqual({ prefix: "uploads/", continuationToken: "next", bucket: undefined });
    expect(result.prefix).toBe("");
    expect(result.folders).toEqual([{ name: "reports", prefix: "reports/" }]);
    expect(result.files.map((file) => file.key)).toEqual(["readme.txt"]);
  });

  it("always prepends the root to download keys", async () => {
    const inner = new RecordingStorage();
    const storage = new ScopedStorage(inner, "uploads/");

    await storage.createDownloadUrl({ key: "reports/file.pdf", expiresInSeconds: 300 });

    expect(inner.downloadInput).toEqual({
      key: "uploads/reports/file.pdf",
      expiresInSeconds: 300,
      bucket: undefined
    });
  });

  it("uses the account bucket for listing and downloads regardless of request input", async () => {
    const inner = new RecordingStorage();
    const storage = new ScopedStorage(inner, "uploads/", "account-bucket");

    await storage.listObjects({ prefix: "reports", bucket: "other-bucket" });
    await storage.createDownloadUrl({
      key: "reports/file.pdf",
      expiresInSeconds: 300,
      bucket: "other-bucket"
    });

    expect(inner.listInput).toEqual({
      prefix: "uploads/reports/",
      continuationToken: undefined,
      bucket: "account-bucket"
    });
    expect(inner.downloadInput).toEqual({
      key: "uploads/reports/file.pdf",
      expiresInSeconds: 300,
      bucket: "account-bucket"
    });
  });

  it("ignores request buckets even when the scope uses the configured default", async () => {
    const inner = new RecordingStorage();
    const storage = new ScopedStorage(inner, "uploads/");

    await storage.listObjects({ prefix: "", bucket: "other-bucket" });
    await storage.createDownloadUrl({ key: "file.pdf", expiresInSeconds: 300, bucket: "other-bucket" });

    expect(inner.listInput?.bucket).toBeUndefined();
    expect(inner.downloadInput?.bucket).toBeUndefined();
  });

  it("rejects traversal-like list and download paths", async () => {
    const storage = new ScopedStorage(new RecordingStorage(), "uploads/");

    await expect(storage.listObjects({ prefix: "../private" })).rejects.toThrow(
      "INVALID_SCOPED_PATH"
    );
    await expect(
      storage.createDownloadUrl({ key: "../private/hidden.txt", expiresInSeconds: 300 })
    ).rejects.toThrow("INVALID_SCOPED_PATH");
  });
});
