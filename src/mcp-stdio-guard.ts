import { Transform, type TransformCallback } from "node:stream";

import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export interface StrictJsonLineInputOptions {
  readonly onRejected: (error: Error) => void;
}

export class StrictJsonLineInput extends Transform {
  readonly #onRejected: (error: Error) => void;
  #buffer = Buffer.alloc(0);
  #rejected = false;

  public constructor(options: StrictJsonLineInputOptions) {
    super();
    this.#onRejected = options.onRejected;
  }

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.#rejected) {
      callback();
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#buffer.length + bytes.length > MAX_BUFFER_SIZE) {
      this.#reject(new SyntaxError("MCP stdio frame exceeds 10 MiB"));
      callback();
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    try {
      while (!this.#rejected) {
        const newline = this.#buffer.indexOf(0x0a);
        if (newline === -1) break;
        let line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
        const text = line.toString("utf8");
        parseJsonRejectingDuplicateKeys(text);
        this.push(Buffer.concat([line, Buffer.from("\n")]));
      }
      callback();
    } catch (error: unknown) {
      this.#reject(asError(error));
      callback();
    }
  }

  public override _flush(callback: TransformCallback): void {
    if (!this.#rejected && this.#buffer.length > 0) {
      this.#reject(new SyntaxError("Incomplete newline-delimited MCP frame"));
    }
    this.#buffer = Buffer.alloc(0);
    callback();
  }

  #reject(error: Error): void {
    if (this.#rejected) return;
    this.#rejected = true;
    this.#buffer = Buffer.alloc(0);
    this.#onRejected(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
