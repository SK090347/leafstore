import fs from "node:fs";
import {
  allocPage,
  encodeFreelist,
  freelistNext,
  readHeaderPage,
  writeHeaderPage,
} from "./page.js";
import { NULL_PAGE, PAGE_SIZE } from "./types.js";

/**
 * Single-file page store. Page 0 is the header; data pages are 1..pageCount-1.
 * Freed pages are chained through an optional freelist (type Freelist).
 */
export class PageFile {
  readonly path: string;
  readonly pageSize: number;
  private fd: number;
  private rootPageId: number;
  private freelistHead: number;
  private pageCount: number;
  private dirtyHeader = false;

  private constructor(
    path: string,
    fd: number,
    pageSize: number,
    rootPageId: number,
    freelistHead: number,
    pageCount: number,
  ) {
    this.path = path;
    this.fd = fd;
    this.pageSize = pageSize;
    this.rootPageId = rootPageId;
    this.freelistHead = freelistHead;
    this.pageCount = pageCount;
  }

  static create(path: string, pageSize = PAGE_SIZE): PageFile {
    const fd = fs.openSync(path, "w+");
    const header = allocPage(pageSize);
    // Empty tree: no root yet (NULL_PAGE). pageCount = 1 (header only).
    writeHeaderPage(header, {
      pageSize,
      rootPageId: NULL_PAGE,
      freelistHead: NULL_PAGE,
      pageCount: 1,
    });
    fs.writeSync(fd, header, 0, pageSize, 0);
    return new PageFile(path, fd, pageSize, NULL_PAGE, NULL_PAGE, 1);
  }

  static open(path: string): PageFile {
    const fd = fs.openSync(path, "r+");
    const probe = Buffer.alloc(PAGE_SIZE);
    fs.readSync(fd, probe, 0, PAGE_SIZE, 0);
    const meta = readHeaderPage(probe);
    if (meta.pageSize !== PAGE_SIZE && meta.pageSize < 512) {
      throw new Error(`leafstore: unsupported page size ${meta.pageSize}`);
    }
    // Re-read with correct page size if needed
    let headerBuf = probe;
    if (meta.pageSize !== PAGE_SIZE) {
      headerBuf = Buffer.alloc(meta.pageSize);
      fs.readSync(fd, headerBuf, 0, meta.pageSize, 0);
    }
    const h = readHeaderPage(headerBuf);
    return new PageFile(
      path,
      fd,
      h.pageSize,
      h.rootPageId,
      h.freelistHead,
      h.pageCount,
    );
  }

  get root(): number {
    return this.rootPageId;
  }

  setRoot(pageId: number): void {
    this.rootPageId = pageId;
    this.dirtyHeader = true;
  }

  get pages(): number {
    return this.pageCount;
  }

  readPage(pageId: number): Buffer {
    if (pageId < 0 || pageId >= this.pageCount) {
      throw new Error(`leafstore: page id out of range: ${pageId}`);
    }
    const buf = allocPage(this.pageSize);
    fs.readSync(this.fd, buf, 0, this.pageSize, pageId * this.pageSize);
    return buf;
  }

  writePage(pageId: number, buf: Buffer): void {
    if (buf.length !== this.pageSize) {
      throw new Error("leafstore: page buffer size mismatch");
    }
    if (pageId < 0 || pageId >= this.pageCount) {
      throw new Error(`leafstore: page id out of range: ${pageId}`);
    }
    fs.writeSync(this.fd, buf, 0, this.pageSize, pageId * this.pageSize);
  }

  /** Allocate a page: prefer freelist, else grow the file. */
  alloc(): number {
    if (this.freelistHead !== NULL_PAGE) {
      const id = this.freelistHead;
      const page = this.readPage(id);
      this.freelistHead = freelistNext(page);
      this.dirtyHeader = true;
      const blank = allocPage(this.pageSize);
      this.writePage(id, blank);
      return id;
    }
    const id = this.pageCount;
    this.pageCount += 1;
    this.dirtyHeader = true;
    const blank = allocPage(this.pageSize);
    // Extend file
    fs.writeSync(this.fd, blank, 0, this.pageSize, id * this.pageSize);
    return id;
  }

  free(pageId: number): void {
    if (pageId === 0) {
      throw new Error("leafstore: cannot free header page");
    }
    const buf = allocPage(this.pageSize);
    encodeFreelist(buf, this.freelistHead);
    this.writePage(pageId, buf);
    this.freelistHead = pageId;
    this.dirtyHeader = true;
  }

  flushHeader(): void {
    if (!this.dirtyHeader) return;
    const header = allocPage(this.pageSize);
    writeHeaderPage(header, {
      pageSize: this.pageSize,
      rootPageId: this.rootPageId,
      freelistHead: this.freelistHead,
      pageCount: this.pageCount,
    });
    this.writePage(0, header);
    this.dirtyHeader = false;
  }

  sync(): void {
    this.flushHeader();
    fs.fsyncSync(this.fd);
  }

  close(): void {
    this.flushHeader();
    fs.closeSync(this.fd);
    this.fd = -1;
  }
}
