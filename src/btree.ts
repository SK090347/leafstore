import {
  childIndexFor,
  compareKeys,
  decodeInternal,
  decodeLeaf,
  encodeInternal,
  encodeLeaf,
  internalEncodedSize,
  leafEncodedSize,
  lowerBoundEntries,
  pageTypeOf,
} from "./page.js";
import { PageFile } from "./pagefile.js";
import {
  NULL_PAGE,
  PAGE_SIZE,
  PageType,
  type LeafEntry,
  type StoreOptions,
} from "./types.js";

function toBuf(x: string | Buffer): Buffer {
  return typeof x === "string" ? Buffer.from(x, "utf8") : x;
}

interface PathFrame {
  pageId: number;
  /** Child index taken from this internal node (undefined for leaf). */
  childIndex?: number;
}

/**
 * On-disk B+ tree over a single PageFile.
 * All keys in leaves; internal nodes hold separator keys + child page ids.
 */
export class BPlusTree {
  private file: PageFile;

  private constructor(file: PageFile) {
    this.file = file;
  }

  static create(opts: StoreOptions): BPlusTree {
    const pageSize = opts.pageSize ?? PAGE_SIZE;
    const file = PageFile.create(opts.path, pageSize);
    const tree = new BPlusTree(file);
    // Allocate empty root leaf
    const rootId = file.alloc();
    const leaf = Buffer.alloc(pageSize);
    encodeLeaf(leaf, [], NULL_PAGE);
    file.writePage(rootId, leaf);
    file.setRoot(rootId);
    file.sync();
    return tree;
  }

  static open(path: string): BPlusTree {
    const file = PageFile.open(path);
    if (file.root === NULL_PAGE) {
      throw new Error("leafstore: file has no root page");
    }
    return new BPlusTree(file);
  }

  get path(): string {
    return this.file.path;
  }

  sync(): void {
    this.file.sync();
  }

  close(): void {
    this.file.close();
  }

  /** Point lookup. Returns value bytes or undefined. */
  get(key: string | Buffer): Buffer | undefined {
    const k = toBuf(key);
    const leafId = this.findLeaf(k);
    const { entries } = decodeLeaf(this.file.readPage(leafId));
    const idx = lowerBoundEntries(entries, k);
    if (idx >= 0 && compareKeys(entries[idx].key, k) === 0) {
      return entries[idx].value;
    }
    return undefined;
  }

  /** Insert or overwrite. */
  put(key: string | Buffer, value: string | Buffer): void {
    const k = toBuf(key);
    const v = toBuf(value);
    const path = this.findPath(k);
    const leafId = path[path.length - 1].pageId;
    const page = this.file.readPage(leafId);
    const { entries, nextLeaf } = decodeLeaf(page);

    const idx = lowerBoundEntries(entries, k);
    if (idx >= 0 && compareKeys(entries[idx].key, k) === 0) {
      entries[idx] = { key: k, value: v };
    } else {
      entries.splice(idx + 1, 0, { key: k, value: v });
    }

    if (leafEncodedSize(entries) <= this.file.pageSize) {
      encodeLeaf(page, entries, nextLeaf);
      this.file.writePage(leafId, page);
      this.file.sync();
      return;
    }

    // Split leaf
    const mid = Math.ceil(entries.length / 2);
    const left = entries.slice(0, mid);
    const right = entries.slice(mid);
    const sep = Buffer.from(right[0].key);

    const rightId = this.file.alloc();
    const leftBuf = Buffer.alloc(this.file.pageSize);
    const rightBuf = Buffer.alloc(this.file.pageSize);
    encodeLeaf(leftBuf, left, rightId);
    encodeLeaf(rightBuf, right, nextLeaf);
    this.file.writePage(leafId, leftBuf);
    this.file.writePage(rightId, rightBuf);

    this.insertIntoParent(path, sep, rightId);
    this.file.sync();
  }

  /**
   * Iterate key/value pairs in order for keys in [start, end).
   * Omit start/end for full scan. Bounds are inclusive/exclusive on raw bytes.
   */
  *range(
    start?: string | Buffer,
    end?: string | Buffer,
  ): Generator<{ key: Buffer; value: Buffer }> {
    const startKey = start !== undefined ? toBuf(start) : null;
    const endKey = end !== undefined ? toBuf(end) : null;

    let leafId: number;
    if (startKey) {
      leafId = this.findLeaf(startKey);
    } else {
      leafId = this.leftmostLeaf();
    }

    while (leafId !== NULL_PAGE) {
      const { entries, nextLeaf } = decodeLeaf(this.file.readPage(leafId));
      for (const e of entries) {
        if (startKey && compareKeys(e.key, startKey) < 0) continue;
        if (endKey && compareKeys(e.key, endKey) >= 0) return;
        yield { key: e.key, value: e.value };
      }
      leafId = nextLeaf;
    }
  }

  /** Convenience: collect all keys as utf8 strings (for tests / demos). */
  keys(): string[] {
    const out: string[] = [];
    for (const { key } of this.range()) {
      out.push(key.toString("utf8"));
    }
    return out;
  }

  // --- internals ---

  private leftmostLeaf(): number {
    let id = this.file.root;
    for (;;) {
      const page = this.file.readPage(id);
      if (pageTypeOf(page) === PageType.Leaf) return id;
      const { children } = decodeInternal(page);
      id = children[0];
    }
  }

  private findLeaf(key: Buffer): number {
    const path = this.findPath(key);
    return path[path.length - 1].pageId;
  }

  private findPath(key: Buffer): PathFrame[] {
    const path: PathFrame[] = [];
    let id = this.file.root;
    for (;;) {
      const page = this.file.readPage(id);
      const type = pageTypeOf(page);
      if (type === PageType.Leaf) {
        path.push({ pageId: id });
        return path;
      }
      if (type !== PageType.Internal) {
        throw new Error(`leafstore: corrupt page type ${type} at ${id}`);
      }
      const { keys, children } = decodeInternal(page);
      const ci = childIndexFor(keys, key);
      path.push({ pageId: id, childIndex: ci });
      id = children[ci];
    }
  }

  private insertIntoParent(
    path: PathFrame[],
    sep: Buffer,
    rightChild: number,
  ): void {
    // path ends at the leaf we split; parent is path[path.length - 2]
    if (path.length === 1) {
      // Split root: new internal root
      const leftChild = path[0].pageId;
      const newRoot = this.file.alloc();
      const buf = Buffer.alloc(this.file.pageSize);
      encodeInternal(buf, [sep], [leftChild, rightChild]);
      this.file.writePage(newRoot, buf);
      this.file.setRoot(newRoot);
      return;
    }

    const parentFrame = path[path.length - 2];
    const parentId = parentFrame.pageId;
    const parentPage = this.file.readPage(parentId);
    const { keys, children } = decodeInternal(parentPage);
    const insertAt = parentFrame.childIndex! + 1;
    // After descending into children[ci], the new right sibling goes at ci+1
    // and separator is inserted at index ci (which equals childIndex).
    const keyAt = parentFrame.childIndex!;
    keys.splice(keyAt, 0, sep);
    children.splice(insertAt, 0, rightChild);

    if (internalEncodedSize(keys, children.length) <= this.file.pageSize) {
      encodeInternal(parentPage, keys, children);
      this.file.writePage(parentId, parentPage);
      return;
    }

    // Split internal
    const mid = Math.floor(keys.length / 2);
    const promote = keys[mid];
    const leftKeys = keys.slice(0, mid);
    const rightKeys = keys.slice(mid + 1);
    const leftChildren = children.slice(0, mid + 1);
    const rightChildren = children.slice(mid + 1);

    const rightId = this.file.alloc();
    const leftBuf = Buffer.alloc(this.file.pageSize);
    const rightBuf = Buffer.alloc(this.file.pageSize);
    encodeInternal(leftBuf, leftKeys, leftChildren);
    encodeInternal(rightBuf, rightKeys, rightChildren);
    this.file.writePage(parentId, leftBuf);
    this.file.writePage(rightId, rightBuf);

    const parentPath = path.slice(0, -1);
    this.insertIntoParent(parentPath, promote, rightId);
  }
}

/** Public store facade matching a simple KV API. */
export class LeafStore {
  private tree: BPlusTree;

  private constructor(tree: BPlusTree) {
    this.tree = tree;
  }

  static create(path: string, pageSize = PAGE_SIZE): LeafStore {
    return new LeafStore(BPlusTree.create({ path, pageSize }));
  }

  static open(path: string): LeafStore {
    return new LeafStore(BPlusTree.open(path));
  }

  put(key: string | Buffer, value: string | Buffer): void {
    this.tree.put(key, value);
  }

  get(key: string | Buffer): Buffer | undefined {
    return this.tree.get(key);
  }

  getString(key: string): string | undefined {
    const v = this.tree.get(key);
    return v?.toString("utf8");
  }

  range(
    start?: string | Buffer,
    end?: string | Buffer,
  ): Generator<{ key: Buffer; value: Buffer }> {
    return this.tree.range(start, end);
  }

  keys(): string[] {
    return this.tree.keys();
  }

  sync(): void {
    this.tree.sync();
  }

  close(): void {
    this.tree.close();
  }
}

// silence unused-import lint if LeafEntry only used via decode
export type { LeafEntry };
