import {
  MAGIC,
  NULL_PAGE,
  PAGE_SIZE,
  PageType,
  VERSION,
  type LeafEntry,
} from "./types.js";

/**
 * Binary layout helpers for fixed-size pages.
 *
 * Header page (id 0):
 *   magic(4) · version(u16) · pageSize(u16) · root(u32) · freelist(u32) · pageCount(u32)
 *
 * Leaf / internal pages share a small common header, then packed payloads.
 * Keys and values are length-prefixed UTF-8/binary blobs; order is lexicographic
 * on raw bytes (which matches UTF-8 for ASCII prefixes).
 */

const HDR_COMMON = 16; // type(1) pad(1) keyCount(u16) nextOrRight(u32) reserved(u32) reserved(u32)

export function allocPage(size = PAGE_SIZE): Buffer {
  return Buffer.alloc(size);
}

export function writeHeaderPage(
  buf: Buffer,
  opts: {
    pageSize: number;
    rootPageId: number;
    freelistHead: number;
    pageCount: number;
  },
): void {
  buf.fill(0);
  MAGIC.copy(buf, 0);
  buf.writeUInt16LE(VERSION, 4);
  buf.writeUInt16LE(opts.pageSize, 6);
  buf.writeUInt32LE(opts.rootPageId, 8);
  buf.writeUInt32LE(opts.freelistHead, 12);
  buf.writeUInt32LE(opts.pageCount, 16);
  buf.writeUInt8(PageType.Header, 20);
}

export function readHeaderPage(buf: Buffer): {
  version: number;
  pageSize: number;
  rootPageId: number;
  freelistHead: number;
  pageCount: number;
} {
  if (buf.subarray(0, 4).compare(MAGIC) !== 0) {
    throw new Error("leafstore: bad magic — not a leafstore data file");
  }
  return {
    version: buf.readUInt16LE(4),
    pageSize: buf.readUInt16LE(6),
    rootPageId: buf.readUInt32LE(8),
    freelistHead: buf.readUInt32LE(12),
    pageCount: buf.readUInt32LE(16),
  };
}

function writeCommon(
  buf: Buffer,
  type: PageType,
  keyCount: number,
  nextOrRight: number,
): void {
  buf.fill(0);
  buf.writeUInt8(type, 0);
  buf.writeUInt8(0, 1);
  buf.writeUInt16LE(keyCount, 2);
  buf.writeUInt32LE(nextOrRight, 4);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(0, 12);
}

export function pageTypeOf(buf: Buffer): PageType {
  return buf.readUInt8(0) as PageType;
}

export function keyCountOf(buf: Buffer): number {
  return buf.readUInt16LE(2);
}

export function nextOf(buf: Buffer): number {
  return buf.readUInt32LE(4);
}

/** Encode a leaf: entries must already be sorted by key. */
export function encodeLeaf(
  buf: Buffer,
  entries: LeafEntry[],
  nextLeaf: number,
): void {
  writeCommon(buf, PageType.Leaf, entries.length, nextLeaf);
  let offset = HDR_COMMON;
  for (const { key, value } of entries) {
    if (key.length > 0xffff || value.length > 0xffff) {
      throw new Error("leafstore: key/value too large for u16 length");
    }
    const need = 4 + key.length + value.length;
    if (offset + need > buf.length) {
      throw new Error("leafstore: leaf overflow during encode");
    }
    buf.writeUInt16LE(key.length, offset);
    buf.writeUInt16LE(value.length, offset + 2);
    key.copy(buf, offset + 4);
    value.copy(buf, offset + 4 + key.length);
    offset += need;
  }
}

export function decodeLeaf(buf: Buffer): {
  entries: LeafEntry[];
  nextLeaf: number;
} {
  if (pageTypeOf(buf) !== PageType.Leaf) {
    throw new Error("leafstore: expected leaf page");
  }
  const n = keyCountOf(buf);
  const nextLeaf = nextOf(buf);
  const entries: LeafEntry[] = [];
  let offset = HDR_COMMON;
  for (let i = 0; i < n; i++) {
    const klen = buf.readUInt16LE(offset);
    const vlen = buf.readUInt16LE(offset + 2);
    const key = Buffer.from(buf.subarray(offset + 4, offset + 4 + klen));
    const value = Buffer.from(
      buf.subarray(offset + 4 + klen, offset + 4 + klen + vlen),
    );
    entries.push({ key, value });
    offset += 4 + klen + vlen;
  }
  return { entries, nextLeaf };
}

/** Bytes needed to encode a leaf with these entries. */
export function leafEncodedSize(entries: LeafEntry[]): number {
  let size = HDR_COMMON;
  for (const { key, value } of entries) {
    size += 4 + key.length + value.length;
  }
  return size;
}

/**
 * Internal node: keys[i] separates children[i] and children[i+1].
 * All keys in children[i] are < keys[i]; all in children[i+1] are >= keys[i].
 */
export function encodeInternal(
  buf: Buffer,
  keys: Buffer[],
  children: number[],
): void {
  if (children.length !== keys.length + 1) {
    throw new Error("leafstore: internal node children must be keys+1");
  }
  writeCommon(buf, PageType.Internal, keys.length, NULL_PAGE);
  let offset = HDR_COMMON;
  // children first (keyCount + 1) u32s, then length-prefixed keys
  for (const child of children) {
    if (offset + 4 > buf.length) {
      throw new Error("leafstore: internal overflow (children)");
    }
    buf.writeUInt32LE(child, offset);
    offset += 4;
  }
  for (const key of keys) {
    if (key.length > 0xffff) {
      throw new Error("leafstore: separator key too large");
    }
    if (offset + 2 + key.length > buf.length) {
      throw new Error("leafstore: internal overflow (keys)");
    }
    buf.writeUInt16LE(key.length, offset);
    key.copy(buf, offset + 2);
    offset += 2 + key.length;
  }
}

export function decodeInternal(buf: Buffer): {
  keys: Buffer[];
  children: number[];
} {
  if (pageTypeOf(buf) !== PageType.Internal) {
    throw new Error("leafstore: expected internal page");
  }
  const n = keyCountOf(buf);
  const children: number[] = [];
  let offset = HDR_COMMON;
  for (let i = 0; i < n + 1; i++) {
    children.push(buf.readUInt32LE(offset));
    offset += 4;
  }
  const keys: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const klen = buf.readUInt16LE(offset);
    keys.push(Buffer.from(buf.subarray(offset + 2, offset + 2 + klen)));
    offset += 2 + klen;
  }
  return { keys, children };
}

export function internalEncodedSize(keys: Buffer[], childCount: number): number {
  let size = HDR_COMMON + childCount * 4;
  for (const key of keys) {
    size += 2 + key.length;
  }
  return size;
}

export function encodeFreelist(buf: Buffer, nextFree: number): void {
  writeCommon(buf, PageType.Freelist, 0, nextFree);
}

export function freelistNext(buf: Buffer): number {
  if (pageTypeOf(buf) !== PageType.Freelist) {
    throw new Error("leafstore: expected freelist page");
  }
  return nextOf(buf);
}

export function compareKeys(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

/** Largest index i where entries[i].key <= key, or -1. */
export function lowerBoundEntries(entries: LeafEntry[], key: Buffer): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareKeys(entries[mid].key, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** First child index whose separator > key (standard B+ descent). */
export function childIndexFor(keys: Buffer[], key: Buffer): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareKeys(key, keys[mid]) < 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
