import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadConfig } from "../config/env.js";
import { S3Storage } from "../storage/s3Storage.js";
import { ScopedStorage } from "../storage/scopedStorage.js";

vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));

function createStorage(): S3Storage {
  return new S3Storage(loadConfig({
    SESSION_SECRET: "storage-test-session-secret",
    S3_ENDPOINT: "https://storage.example.test",
    S3_BUCKET: "default-bucket",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key"
  }));
}

describe("S3Storage bucket selection", () => {
  let send = vi.spyOn(S3Client.prototype, "send");

  beforeEach(() => {
    send = vi.spyOn(S3Client.prototype, "send");
    send.mockReset();
    vi.mocked(getSignedUrl).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the environment default when no account bucket is provided", async () => {
    send.mockImplementation(async () => ({}));
    vi.mocked(getSignedUrl).mockResolvedValue("https://storage.example.test/download");
    const storage = createStorage();

    await storage.listObjects({ prefix: "uploads" });
    await storage.prefixExists("uploads");
    await storage.createDownloadUrl({ key: "uploads/file.txt", expiresInSeconds: 300 });

    expect(send.mock.calls.map(([command]) => (command as ListObjectsV2Command).input.Bucket))
      .toEqual(["default-bucket", "default-bucket"]);
    const [, command] = vi.mocked(getSignedUrl).mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input.Bucket).toBe("default-bucket");
  });

  it("keeps concurrent account list and download requests in their assigned buckets", async () => {
    send.mockImplementation(async () => ({}));
    vi.mocked(getSignedUrl).mockResolvedValue("https://storage.example.test/download");
    const inner = createStorage();
    const first = new ScopedStorage(inner, "uploads/", "first-bucket");
    const second = new ScopedStorage(inner, "reports/", "second-bucket");

    await Promise.all([
      first.listObjects({ prefix: "invoices", continuationToken: "next-page", bucket: "untrusted-bucket" }),
      second.listObjects({ prefix: "", bucket: "untrusted-bucket" }),
      first.createDownloadUrl({ key: "invoice.txt", expiresInSeconds: 120, bucket: "untrusted-bucket" }),
      second.createDownloadUrl({ key: "report.txt", expiresInSeconds: 180, bucket: "untrusted-bucket" })
    ]);

    const listCommands = send.mock.calls.map(([command]) => command as ListObjectsV2Command);
    expect(listCommands.every((command) => command instanceof ListObjectsV2Command)).toBe(true);
    expect(listCommands.map((command) => command.input)).toEqual([
      { Bucket: "first-bucket", Prefix: "uploads/invoices/", Delimiter: "/", ContinuationToken: "next-page" },
      { Bucket: "second-bucket", Prefix: "reports/", Delimiter: "/", ContinuationToken: undefined }
    ]);
    expect(vi.mocked(getSignedUrl).mock.calls.map(([, command, options]) => ({
      bucket: (command as GetObjectCommand).input.Bucket,
      key: (command as GetObjectCommand).input.Key,
      expiresIn: options?.expiresIn
    }))).toEqual([
      { bucket: "first-bucket", key: "uploads/invoice.txt", expiresIn: 120 },
      { bucket: "second-bucket", key: "reports/report.txt", expiresIn: 180 }
    ]);

    await inner.listObjects({ prefix: "" });
    expect((send.mock.calls[2][0] as ListObjectsV2Command).input.Bucket).toBe("default-bucket");
  });

  it("checks prefix existence in the selected bucket and accepts an empty root", async () => {
    send.mockImplementationOnce(async () => ({ KeyCount: 1 }))
      .mockImplementationOnce(async () => ({ KeyCount: 0 }))
      .mockImplementationOnce(async () => ({ KeyCount: 0 }));
    const storage = createStorage();

    await expect(storage.prefixExists("uploads", "account-bucket")).resolves.toBe(true);
    await expect(storage.prefixExists("missing", "account-bucket")).resolves.toBe(false);
    await expect(storage.prefixExists("", "empty-bucket")).resolves.toBe(true);

    expect(send.mock.calls.map(([command]) => (command as ListObjectsV2Command).input)).toEqual([
      { Bucket: "account-bucket", Prefix: "uploads/", MaxKeys: 1 },
      { Bucket: "account-bucket", Prefix: "missing/", MaxKeys: 1 },
      { Bucket: "empty-bucket", Prefix: "", MaxKeys: 1 }
    ]);
  });

  it("validates an existing empty bucket with HeadBucket", async () => {
    send.mockImplementation(async () => ({}));

    await expect(createStorage().bucketExists("empty-bucket")).resolves.toBe(true);

    const [command] = send.mock.calls[0];
    expect(command).toBeInstanceOf(HeadBucketCommand);
    expect((command as HeadBucketCommand).input).toEqual({ Bucket: "empty-bucket" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error("Not found"), { $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error("No such bucket"), { name: "NoSuchBucket" })
  ])("returns false for a nonexistent bucket (%s)", async (error) => {
    send.mockRejectedValue(error);

    await expect(createStorage().bucketExists("missing-bucket")).resolves.toBe(false);
  });

  it.each([
    Object.assign(new Error("Forbidden"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error("Network unavailable"), { code: "ECONNREFUSED" })
  ])("reports failed checks separately from nonexistent buckets (%s)", async (error) => {
    send.mockRejectedValue(error);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(createStorage().bucketExists("account-bucket")).rejects.toThrow("S3_BUCKET_CHECK_FAILED");
  });
});
