import { Transform, type TransformCallback } from "node:stream";

import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

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
    try {
      this.#consume(bytes);
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

  #consume(bytes: Buffer): void {
    let offset = 0;
    while (!this.#rejected && offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        const remainder = bytes.subarray(offset);
        const pendingLength = this.#buffer.length + remainder.length;
        const lastByte = remainder.at(-1) ?? this.#buffer.at(-1);
        const maximumPendingLength =
          lastByte === 0x0d ? MAX_BUFFER_SIZE + 1 : MAX_BUFFER_SIZE;
        if (pendingLength > maximumPendingLength) {
          this.#reject(new SyntaxError("MCP stdio frame exceeds 10 MiB"));
          return;
        }
        this.#buffer = Buffer.concat([this.#buffer, remainder]);
        return;
      }

      const segment = bytes.subarray(offset, newline);
      const completeLength = this.#buffer.length + segment.length;
      const lastByte = segment.at(-1) ?? this.#buffer.at(-1);
      const payloadLength = completeLength - (lastByte === 0x0d ? 1 : 0);
      if (payloadLength > MAX_BUFFER_SIZE) {
        this.#reject(new SyntaxError("MCP stdio frame exceeds 10 MiB"));
        return;
      }
      let line = Buffer.concat([this.#buffer, segment]);
      this.#buffer = Buffer.alloc(0);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      let text: string;
      try {
        text = UTF8_DECODER.decode(line);
      } catch {
        throw new SyntaxError("MCP stdio frame contains invalid UTF-8");
      }
      parseJsonRejectingDuplicateKeys(text);
      this.push(Buffer.concat([Buffer.from(text, "utf8"), Buffer.from("\n")]));
      offset = newline + 1;
    }
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
