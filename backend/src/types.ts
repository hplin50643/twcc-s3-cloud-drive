export type UserRole = "admin" | "user";

export interface AppUser {
  id: number;
  username: string;
  role: UserRole;
  s3Prefix: string;
  s3Bucket: string;
}

export interface FolderItem {
  name: string;
  prefix: string;
}

export interface FileItem {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
}

export interface ObjectListResult {
  prefix: string;
  folders: FolderItem[];
  files: FileItem[];
  nextContinuationToken: string | null;
}

export interface StorageClient {
  listObjects(input: {
    prefix: string;
    continuationToken?: string;
    bucket?: string;
  }): Promise<ObjectListResult>;
  createDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    bucket?: string;
  }): Promise<string>;
}

export interface StorageAdminClient extends StorageClient {
  prefixExists(prefix: string, bucket?: string): Promise<boolean>;
  bucketExists(bucket: string): Promise<boolean>;
}
