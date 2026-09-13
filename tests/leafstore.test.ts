import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LeafStore, PAGE_SIZE } from "../src/index.js";

const tmpFiles: string[] = [];

function tmpDb(name: string): string {
  const p = path.join(
    os.tmpdir(),
    `leafstore-${name}-${process.pid}-${Date.now()}.db`,
  );
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

describe("insert / get", () => {
  it("stores and retrieves string keys", () => {
    const db = LeafStore.create(tmpDb("basic"));
    db.put("alpha", "one");
    db.put("beta", "two");
    db.put("gamma", "three");
    expect(db.getString("alpha")).toBe("one");
    expect(db.getString("beta")).toBe("two");
    expect(db.getString("gamma")).toBe("three");
    expect(db.get("missing")).toBeUndefined();
    db.close();
  });

  it("overwrites existing keys", () => {
    const db = LeafStore.create(tmpDb("overwrite"));
    db.put("k", "v1");
    db.put("k", "v2");
    expect(db.getString("k")).toBe("v2");
    db.close();
  });

  it("handles binary keys and values", () => {
    const db = LeafStore.create(tmpDb("bin"));
    const key = Buffer.from([0x00, 0xff, 0x10]);
    const val = Buffer.from([1, 2, 3, 4]);
    db.put(key, val);
    expect(db.get(key)?.equals(val)).toBe(true);
    db.close();
  });

  it("survives many inserts that force leaf and internal splits", () => {
    const db = LeafStore.create(tmpDb("split"), PAGE_SIZE);
    const n = 500;
    for (let i = 0; i < n; i++) {
      const k = `key-${String(i).padStart(5, "0")}`;
      db.put(k, `val-${i}`);
    }
    for (let i = 0; i < n; i++) {
      const k = `key-${String(i).padStart(5, "0")}`;
      expect(db.getString(k)).toBe(`val-${i}`);
    }
    expect(db.keys()).toHaveLength(n);
    db.close();
  });

  it("accepts reverse-order inserts and keeps sorted order", () => {
    const db = LeafStore.create(tmpDb("rev"));
    for (let i = 99; i >= 0; i--) {
      db.put(`k${String(i).padStart(3, "0")}`, String(i));
    }
    expect(db.keys()).toEqual(
      Array.from({ length: 100 }, (_, i) => `k${String(i).padStart(3, "0")}`),
    );
    db.close();
  });
});

describe("persistence", () => {
  it("reopens the same file and reads back values", () => {
    const file = tmpDb("persist");
    {
      const db = LeafStore.create(file);
      db.put("hello", "world");
      db.put("leaf", "store");
      for (let i = 0; i < 200; i++) {
        db.put(`n${i}`, `v${i}`);
      }
      db.close();
    }
    {
      const db = LeafStore.open(file);
      expect(db.getString("hello")).toBe("world");
      expect(db.getString("leaf")).toBe("store");
      expect(db.getString("n42")).toBe("v42");
      expect(db.getString("n199")).toBe("v199");
      db.put("hello", "again");
      db.close();
    }
    {
      const db = LeafStore.open(file);
      expect(db.getString("hello")).toBe("again");
      db.close();
    }
  });

  it("rejects a non-leafstore file", () => {
    const file = tmpDb("bad");
    fs.writeFileSync(file, Buffer.alloc(PAGE_SIZE, 0xab));
    expect(() => LeafStore.open(file)).toThrow(/magic/);
  });
});

describe("range scan", () => {
  it("iterates all keys in lexicographic order", () => {
    const db = LeafStore.create(tmpDb("range-all"));
    const keys = ["delta", "alpha", "charlie", "bravo"];
    for (const k of keys) db.put(k, k.toUpperCase());
    const got = [...db.range()].map((e) => e.key.toString("utf8"));
    expect(got).toEqual(["alpha", "bravo", "charlie", "delta"]);
    db.close();
  });

  it("respects [start, end) bounds across leaf siblings", () => {
    const db = LeafStore.create(tmpDb("range-bounds"));
    for (let i = 0; i < 300; i++) {
      db.put(`k${String(i).padStart(4, "0")}`, String(i));
    }
    const got = [...db.range("k0100", "k0110")].map((e) =>
      e.key.toString("utf8"),
    );
    expect(got).toEqual([
      "k0100",
      "k0101",
      "k0102",
      "k0103",
      "k0104",
      "k0105",
      "k0106",
      "k0107",
      "k0108",
      "k0109",
    ]);
    // end exclusive
    expect(got.includes("k0110")).toBe(false);
    db.close();
  });

  it("empty range yields nothing", () => {
    const db = LeafStore.create(tmpDb("range-empty"));
    db.put("a", "1");
    db.put("z", "2");
    expect([...db.range("m", "n")]).toHaveLength(0);
    db.close();
  });
});
