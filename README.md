# leafstore

On-disk B+ tree KV in TypeScript. One file, fixed-size pages, `put` / `get` / ordered `range` — reopen the file and the keys are still there. Pair it with [lumen-kv](https://github.com/SK090347/lumen-kv) if you want the LSM side of the textbook too.

[![CI](https://github.com/SK090347/leafstore/actions/workflows/ci.yml/badge.svg)](https://github.com/SK090347/leafstore/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE)

Sumit Kumar Ta ([SK090347](https://github.com/SK090347)) · Adamas University

## API

| Op | Behavior |
|----|----------|
| `put(key, value)` | Insert/overwrite; split when a page would overflow |
| `get(key)` | Descend separators → leaf binary search |
| `range(start?, end?)` | In-order leaf walk; `[start, end)` on raw bytes |
| Persistence | Header page tracks root, freelist, page count |

Keys/values are opaque bytes (UTF-8 if you pass strings). Lexicographic order.

## Pages

Default page size **4096** bytes.

- **Page 0 (header):** magic `LEAF`, version, page size, root id, freelist head, page count.
- **Leaves:** packed key/value entries + right-sibling pointer; split ~halfway, push min key of the right sibling up.
- **Internals:** `n` separators fence `n+1` children; descent is binary search.

See `src/page.ts` for the pack/unpack details.

## Quick start

```bash
npm install && npm test && npm run build
```

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

## Layout

```
src/
  types.ts      page size, magic, kinds
  page.ts       encode/decode header, leaf, internal, freelist
  pagefile.ts   single-file I/O, alloc, fsync
  btree.ts      insert, get, range, LeafStore facade
tests/
```

## Limits (honest)

- `put` syncs dirty pages — not a WAL with mid-write crash recovery
- No delete API yet (freelist is wired for later reclaim)
- Values that won’t fit one page are rejected
- Node 18+, pure TypeScript

## License

**MIT** OR **Apache-2.0** — see LICENSE files and NOTICE.
