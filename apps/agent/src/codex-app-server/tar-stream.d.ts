declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";

  export interface Header {
    readonly name: string;
    readonly type?: string;
    readonly mode?: number;
    readonly size?: number;
    readonly linkname?: string | null;
    readonly uid?: number;
    readonly gid?: number;
    readonly mtime?: Date;
  }

  export interface Pack extends Readable {
    entry(header: Header, callback?: (error?: Error | null) => void): Writable;
    entry(header: Header, body: Uint8Array, callback?: (error?: Error | null) => void): Writable;
    finalize(): void;
  }

  export interface Extract extends Writable {
    on(event: "entry", listener: (header: Header, stream: Readable, next: (error?: Error | null) => void) => void): this;
  }

  export function pack(): Pack;
  export function extract(): Extract;
}
