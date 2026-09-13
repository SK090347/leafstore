/** Fixed page size used by the on-disk B+ tree (bytes). */
export const PAGE_SIZE = 4096;

/** Magic bytes at the start of page 0: "LEAF". */
export const MAGIC = Buffer.from("LEAF");

export const VERSION = 1;

export enum PageType {
  Header = 0,
  Leaf = 1,
  Internal = 2,
  Freelist = 3,
}

/** Sentinel page id meaning "none". */
export const NULL_PAGE = 0xffffffff;

export interface StoreOptions {
  /** Path to the single data file. */
  path: string;
  /** Page size in bytes (default 4096). Must match an existing file. */
  pageSize?: number;
}

export interface LeafEntry {
  key: Buffer;
  value: Buffer;
}
