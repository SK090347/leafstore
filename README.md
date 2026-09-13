# leafstore

**On-disk B+ tree key-value store** in TypeScript (Node). Fixed-size pages, a single data file, insert / get / ordered range scan — the storage-engine cousin of an LSM lab, built so you can open the file after reopen and still find your keys.

[![CI](https://github.com/SK090347/leafstore/actions/workflows/ci.yml/badge.svg)](https://github.com/SK090347/leafstore/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE-APACHE)

> Built by [Sumit Kumar Ta](https://github.com/SK090347) — a small systems lab: pages on disk, not a wrapper around SQLite.

Dual-licensed **MIT OR Apache-2.0**. See [LICENSE](LICENSE), [LICENSE-APACHE](LICENSE-APACHE), and [NOTICE](NOTICE).

---

## Why this exists

Most “KV in TypeScript” demos stop at an in-memory map. Real engines argue with **pages**: fixed blocks, a free list, leaf splits, and separator keys in internal nodes. `leafstore` is that argument written down — enough of a B+ tree to insert, point-get, and walk keys in order after you close and reopen the file.

It sits next to [lumen-kv](https://github.com/SK090347/lumen-kv) (LSM write path) as the other classic textbook layout: **reads stay cheap**, writes update pages in place and split when they fill.

---

## What you get

| Operation | Behavior |
|-----------|----------|
| `put(key, value)` | Insert or overwrite; splits leaves / internals when a page would overflow |
| `get(key)` | Descend internal separators → leaf binary search |
| `range(start?, end?)` | In-order walk of leaf siblings; `[start, end)` on raw bytes |
| Persistence | One file; header page tracks root, freelist, page count |

Keys and values are opaque byte strings (UTF-8 when you pass JS strings). Ordering is lexicographic on bytes.

---

## Page layout (prose, not a slide)

Every file is a sequence of **4096-byte pages** (configurable at create time).

**Page 0** is the header: a four-byte magic (`LEAF`), version, page size, root page id, freelist head, and how many pages the file currently owns. If the freelist head is set, recycled pages are chained there instead of always growing the file.

**Leaf pages** hold the actual key/value pairs, packed after a short common header (type, key count, pointer to the next leaf on the right). Each entry is `keyLen` / `valueLen` (16-bit) then the bytes. When a leaf no longer fits, it splits roughly in half; the smallest key on the new right sibling is pushed up as a separator.

**Internal pages** store separator keys and child page ids — classic B+: `n` keys fence `n+1` children. All keys in child `i` are strictly less than separator `i`; everything in child `i+1` is greater or equal. Descent is a binary search over those separators.

Nothing fancy lives in the page format on purpose. If you can sketch a slotted page on a whiteboard, you can read `src/page.ts` without a decoder ring.

---

## Quick start

```bash
git clone https://github.com/SK090347/leafstore.git
cd leafstore
npm install
npm test
npm run build
```

Library usage:

```ts
import { LeafStore } from "leafstore";

const db = LeafStore.create("./demo.db");
db.put("alpha", "one");
db.put("beta", "two");
console.log(db.getString("alpha")); // "one"

for (const { key, value } of db.range("a", "c")) {
  console.log(key.toString(), value.toString());
}
db.close();

const again = LeafStore.open("./demo.db");
console.log(again.getString("beta")); // "two"
again.close();
```

---

## Layout of the repo

```
src/
  types.ts      # page size, magic, page kinds
  page.ts       # encode / decode header, leaf, internal, freelist
  pagefile.ts   # single-file I/O, alloc, freelist, fsync
  btree.ts      # B+ insert, get, range, LeafStore facade
  index.ts      # public exports
tests/
  leafstore.test.ts
.github/workflows/ci.yml
```

---

## Design notes / limits

- **Educational durability**: `put` syncs the header and dirty pages; this is not a WAL with crash recovery between page writes.
- **No delete API yet** — freelist plumbing exists so reclaiming pages later is straightforward.
- **Variable-length keys** share a page; very large values that cannot fit one page are rejected (keep values page-sized for the lab).
- Node 18+; pure TypeScript, no native addons.

---

## License

Copyright 2026 Sumit Kumar Ta (SK090347).

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE)), or
- MIT license ([LICENSE](LICENSE)),

at your option.
