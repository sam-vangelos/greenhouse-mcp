import { Buffer } from "node:buffer";
import type { GcsBucketLike, GcsObjectFileLike, GcsStorageLike } from "../src/audit-gcs.js";

export interface FakeGcsSave {
  bucket: string;
  path: string;
  data: string;
  options: {
    preconditionOpts?: { ifGenerationMatch?: number | string };
    resumable?: boolean;
    contentType?: string;
  };
}

export interface FakeGcsStorage {
  storage: GcsStorageLike;
  /** Every successful save, in order, with the exact options the sink passed. */
  saves: FakeGcsSave[];
  /** Every successful delete, in order (object paths). */
  deletes: string[];
  /** Every download, in order (object paths). */
  downloads: string[];
  /** Every getFiles listing call, in order (the prefix each was given). */
  listPrefixes: string[];
  /** Surviving object contents by path (saves minus deletes, plus seeds). */
  objects: Map<string, string>;
  /** Make saves matching the pattern throw (null clears). */
  failSavesMatching: (pattern: RegExp | null) => void;
  /** Make deletes matching the pattern throw (null clears). */
  failDeletesMatching: (pattern: RegExp | null) => void;
  /** Pre-populate an object without recording a save. */
  seedObject: (path: string, data: string) => void;
}

// In-memory GcsStorageLike double. Mimics the two live behaviors the audit backend depends on:
// create-only saves (ifGenerationMatch: 0 against an existing object throws a 412-coded error, the
// way real GCS refuses to overwrite) and lexicographically ordered listings.
export function createFakeGcsStorage(): FakeGcsStorage {
  const saves: FakeGcsSave[] = [];
  const deletes: string[] = [];
  const downloads: string[] = [];
  const listPrefixes: string[] = [];
  const objects = new Map<string, string>();
  let failSaves: RegExp | null = null;
  let failDeletes: RegExp | null = null;

  function fileFor(bucketName: string, path: string): GcsObjectFileLike {
    return {
      name: path,
      async save(data, options) {
        if (failSaves?.test(path)) {
          throw new Error("fake GCS save failure");
        }
        if (options.preconditionOpts?.ifGenerationMatch === 0 && objects.has(path)) {
          throw Object.assign(new Error("precondition failed"), { code: 412 });
        }
        saves.push({ bucket: bucketName, path, data, options });
        objects.set(path, data);
      },
      async delete() {
        if (failDeletes?.test(path)) {
          throw new Error("fake GCS delete failure");
        }
        deletes.push(path);
        objects.delete(path);
      },
      async download() {
        downloads.push(path);
        const data = objects.get(path);
        if (data === undefined) {
          throw Object.assign(new Error("no such object"), { code: 404 });
        }
        return [Buffer.from(data, "utf8")];
      },
    };
  }

  function bucketFor(bucketName: string): GcsBucketLike {
    return {
      file(path) {
        return fileFor(bucketName, path);
      },
      async getFiles(query) {
        listPrefixes.push(query.prefix);
        const names = [...objects.keys()].filter((name) => name.startsWith(query.prefix)).sort();
        return [names.map((name) => fileFor(bucketName, name))];
      },
    };
  }

  return {
    storage: { bucket: bucketFor },
    saves,
    deletes,
    downloads,
    listPrefixes,
    objects,
    failSavesMatching(pattern) {
      failSaves = pattern;
    },
    failDeletesMatching(pattern) {
      failDeletes = pattern;
    },
    seedObject(path, data) {
      objects.set(path, data);
    },
  };
}
