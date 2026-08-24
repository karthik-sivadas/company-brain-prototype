/**
 * Reassembles OMP's chunked RPC frames.
 *
 * The `ready` frame advertises `maxFrameBytes` (1 MiB) and `maxReassembledFrameBytes` (64 MiB):
 * anything larger than a single frame arrives as a sequence of `rpc_chunk` frames carrying
 * base64 slices. A newline-splitting reader alone silently drops those payloads, which is how
 * long answers and large tool results go missing.
 *
 * Ported from the earlier company-brain implementation, which had this correct.
 */

export type OmpRpcFrame = Record<string, unknown> & { type: string };

interface RpcChunkFrame {
  chunkId: string;
  index: number;
  count: number;
  byteLength: number;
  data: string;
}

interface PendingSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  parts: Buffer[];
  receivedBytes: number;
}

export class OmpRpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmpRpcProtocolError';
  }
}

export class RpcFrameDecoder {
  readonly maxReassembledBytes: number;
  #pending: PendingSequence | undefined;

  constructor(options: { maxReassembledBytes?: number } = {}) {
    const limit = options.maxReassembledBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new OmpRpcProtocolError('a positive RPC reassembly limit is required');
    }
    this.maxReassembledBytes = limit;
  }

  /** Feeds one decoded frame. Returns a complete frame, or undefined while a sequence is still arriving. */
  push(frame: OmpRpcFrame): OmpRpcFrame | undefined {
    if (frame.type !== 'rpc_chunk') {
      if (this.#pending) {
        this.#pending = undefined;
        throw new OmpRpcProtocolError('an RPC chunk sequence was interrupted');
      }
      return frame;
    }

    const chunk = toChunkFrame(frame);
    const part = Buffer.from(chunk.data, 'base64');
    if (part.toString('base64') !== chunk.data) {
      throw new OmpRpcProtocolError('an RPC chunk contains invalid base64 data');
    }

    if (!this.#pending) {
      if (chunk.index !== 0) throw new OmpRpcProtocolError('an RPC chunk sequence must start at index zero');
      if (chunk.byteLength > this.maxReassembledBytes) {
        throw new OmpRpcProtocolError('an RPC chunk sequence exceeds the reassembly limit');
      }
      this.#pending = {
        chunkId: chunk.chunkId, count: chunk.count, byteLength: chunk.byteLength,
        nextIndex: 0, parts: [], receivedBytes: 0,
      };
    }

    const pending = this.#pending;
    const mismatched =
      chunk.chunkId !== pending.chunkId ||
      chunk.count !== pending.count ||
      chunk.byteLength !== pending.byteLength ||
      chunk.index !== pending.nextIndex;
    if (mismatched) {
      this.#pending = undefined;
      throw new OmpRpcProtocolError('an RPC chunk sequence is interleaved or out of order');
    }

    pending.parts.push(part);
    pending.receivedBytes += part.byteLength;
    pending.nextIndex += 1;

    if (pending.receivedBytes > pending.byteLength || pending.receivedBytes > this.maxReassembledBytes) {
      this.#pending = undefined;
      throw new OmpRpcProtocolError('an RPC chunk sequence exceeded its declared size');
    }
    if (pending.nextIndex < pending.count) return undefined;

    this.#pending = undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw new OmpRpcProtocolError('an RPC chunk sequence ended at an unexpected size');
    }

    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.parts));
      return parseFrame(text);
    } catch (error) {
      if (error instanceof OmpRpcProtocolError) throw error;
      throw new OmpRpcProtocolError('an RPC chunk sequence did not decode to a JSON object');
    }
  }

  /** True while a chunk sequence is mid-flight (used by tests and shutdown checks). */
  get isReassembling(): boolean { return this.#pending !== undefined; }
}

export function parseFrame(line: string): OmpRpcFrame {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new OmpRpcProtocolError('omp emitted invalid JSON'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OmpRpcProtocolError('omp emitted a non-object RPC frame');
  }
  const frame = parsed as OmpRpcFrame;
  if (typeof frame.type !== 'string' || frame.type.length === 0) {
    throw new OmpRpcProtocolError('omp emitted an RPC frame without a type');
  }
  return frame;
}

function toChunkFrame(frame: OmpRpcFrame): RpcChunkFrame {
  const { chunkId, index, count, byteLength, data } = frame as Record<string, unknown>;
  const wellTyped =
    typeof chunkId === 'string' && typeof index === 'number' && typeof count === 'number' &&
    typeof byteLength === 'number' && typeof data === 'string';
  if (!wellTyped) throw new OmpRpcProtocolError('omp emitted an invalid RPC chunk frame');

  const sane =
    Number.isSafeInteger(index) && Number.isSafeInteger(count) && Number.isSafeInteger(byteLength) &&
    index >= 0 && count > 0 && index < count && byteLength >= 0;
  if (!sane) throw new OmpRpcProtocolError('omp emitted an invalid RPC chunk frame');

  return { chunkId, index, count, byteLength, data };
}
