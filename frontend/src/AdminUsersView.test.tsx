import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiSessionState } from "./api";
import { AdminUsersView } from "./AdminUsersView";
import type { AdminUser } from "./types";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const administrator: AdminUser = {
  id: 1, username: "alice", role: "admin", s3Bucket: "account-bucket", s3Prefix: "reports/", note: "",
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z"
};
const accounts = () => json({ users: [administrator], defaultS3Bucket: "environment-bucket" });
const requestBody = (url: string) => JSON.parse(fetchMock.mock.calls.find(([path]) => path === url)?.[1]?.body as string);

beforeEach(() => { clearApiSessionState(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); fetchMock.mockReset(); });

async function openEditor() {
  render(<AdminUsersView currentUser={administrator} onSessionEnded={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "編輯 alice" }));
}

describe("account S3 buckets", () => {
  it("prefills new accounts from the environment default and submits the selected bucket", async () => {
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(json({ user: { ...administrator, id: 2, username: "bob", s3Bucket: "new-bucket" } }))
      .mockResolvedValueOnce(accounts());
    render(<AdminUsersView currentUser={administrator} onSessionEnded={vi.fn()} />);
    expect(await screen.findByText("account-bucket")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新增帳號" }));
    expect(screen.getByLabelText("S3 Bucket")).toHaveValue("environment-bucket");
    fireEvent.change(screen.getByLabelText("帳號"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("密碼"), { target: { value: "password-test" } });
    fireEvent.change(screen.getByLabelText("確認密碼"), { target: { value: "password-test" } });
    fireEvent.change(screen.getByLabelText("S3 Bucket"), { target: { value: "new-bucket" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    expect(await screen.findByText("已新增帳號 bob。")).toBeInTheDocument();
    const [, request] = fetchMock.mock.calls.find(([path, init]) => path === "/api/v1/admin/users" && init.method === "POST")!;
    expect(JSON.parse(request.body)).toMatchObject({ username: "bob", s3Bucket: "new-bucket", s3Prefix: "uploads/" });
  });

  it("prefills and saves the account bucket when editing", async () => {
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(json({ user: { ...administrator, s3Bucket: "edited-bucket" }, signedOut: false }))
      .mockResolvedValueOnce(accounts());
    await openEditor();
    expect(screen.getByLabelText("S3 Bucket")).toHaveValue("account-bucket");
    fireEvent.change(screen.getByLabelText("S3 Bucket"), { target: { value: "edited-bucket" } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    expect(await screen.findByText("已更新帳號 alice。")).toBeInTheDocument();
    expect(requestBody("/api/v1/admin/users/1")).toMatchObject({ s3Bucket: "edited-bucket", s3Prefix: "reports/" });
  });

  it("verifies the selected bucket and path, clearing both results after a bucket change", async () => {
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(json({ s3Bucket: "account-bucket", exists: true }))
      .mockResolvedValueOnce(json({ s3Bucket: "account-bucket", normalizedPrefix: "reports/", exists: true, wholeBucket: false }));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "驗證 Bucket" }));
    expect(await screen.findByText("S3 Bucket 存在。")).toBeInTheDocument();
    expect(requestBody("/api/v1/admin/s3-buckets/validate")).toEqual({ s3Bucket: "account-bucket" });
    fireEvent.click(screen.getByRole("button", { name: "驗證路徑" }));
    expect(await screen.findByText("路徑存在。")).toBeInTheDocument();
    expect(requestBody("/api/v1/admin/s3-paths/validate")).toEqual({ s3Bucket: "account-bucket", s3Prefix: "reports/" });
    fireEvent.change(screen.getByLabelText("S3 Bucket"), { target: { value: "another-bucket" } });
    expect(screen.queryByText("S3 Bucket 存在。")).not.toBeInTheDocument();
    expect(screen.queryByText("路徑存在。")).not.toBeInTheDocument();
  });

  it("shows missing buckets as a failed verification", async () => {
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(json({ s3Bucket: "account-bucket", exists: false }));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "驗證 Bucket" }));
    expect(await screen.findByText("S3 Bucket 不存在。")).toHaveClass("form-error");
  });

  it.each([
    ["INVALID_S3_BUCKET", "S3 Bucket 名稱格式不正確。"],
    ["S3_BUCKET_NOT_FOUND", "S3 Bucket 不存在。"],
    ["S3_BUCKET_CHECK_FAILED", "無法驗證 S3 Bucket，請確認存取權限或稍後再試。"]
  ])("translates %s validation errors", async (code, message) => {
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockResolvedValueOnce(json({ error: { code, message: "Server detail" } }, 400));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "驗證 Bucket" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("ignores bucket and path responses for a bucket that has since changed", async () => {
    let resolveBucket!: (response: Response) => void;
    let resolvePath!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveBucket = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePath = resolve; }));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "驗證 Bucket" }));
    await waitFor(() => expect(resolveBucket).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "驗證路徑" }));
    await waitFor(() => expect(resolvePath).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("S3 Bucket"), { target: { value: "another-bucket" } });
    await act(async () => {
      resolveBucket(json({ s3Bucket: "account-bucket", exists: true }));
      resolvePath(json({ s3Bucket: "account-bucket", normalizedPrefix: "old-path/", exists: true, wholeBucket: false }));
    });
    expect(screen.getByLabelText("S3 Bucket")).toHaveValue("another-bucket");
    expect(screen.getByLabelText("S3 路徑")).toHaveValue("reports/");
    expect(screen.queryByText("S3 Bucket 存在。")).not.toBeInTheDocument();
    expect(screen.queryByText("路徑存在。")).not.toBeInTheDocument();
  });

  it("ignores an old path response when the path input changes", async () => {
    let resolvePath!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(accounts())
      .mockResolvedValueOnce(json({ csrfToken: "csrf-test" }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePath = resolve; }));
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "驗證路徑" }));
    await waitFor(() => expect(resolvePath).toBeTypeOf("function"));
    fireEvent.change(screen.getByLabelText("S3 路徑"), { target: { value: "new-path/" } });
    await act(async () => { resolvePath(json({ s3Bucket: "account-bucket", normalizedPrefix: "reports/", exists: true, wholeBucket: false })); });
    expect(screen.getByLabelText("S3 路徑")).toHaveValue("new-path/");
    expect(screen.queryByText("路徑存在。")).not.toBeInTheDocument();
  });
});
