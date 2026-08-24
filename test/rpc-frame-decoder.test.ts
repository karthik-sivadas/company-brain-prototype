import { test, expect } from 'bun:test';
import { RpcFrameDecoder, parseFrame, OmpRpcProtocolError } from '../src/core/RpcFrameDecoder.ts';

/** Splits a frame into base64 rpc_chunk frames the way omp does for oversized payloads. */
function chunkify(frame: object, parts: number) {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  const size = Math.ceil(json.byteLength / parts);
  const chunks = [];
  for (let i = 0; i < parts; i += 1) {
    chunks.push({
      type: 'rpc_chunk', chunkId: 'seq-1', index: i, count: parts,
      byteLength: json.byteLength,
      data: json.subarray(i * size, Math.min((i + 1) * size, json.byteLength)).toString('base64'),
    });
  }
  return chunks;
}

test('passes ordinary frames straight through', () => {
  const d = new RpcFrameDecoder();
  expect(d.push({ type: 'agent_end' })?.type).toBe('agent_end');
  expect(d.isReassembling).toBe(false);
});

test('reassembles a chunked frame — the payload a newline reader would lose', () => {
  const big = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(5000) }] } };
  const d = new RpcFrameDecoder();
  const chunks = chunkify(big, 5);

  for (const c of chunks.slice(0, -1)) {
    expect(d.push(c)).toBeUndefined();       // still assembling
    expect(d.isReassembling).toBe(true);
  }
  const out = d.push(chunks.at(-1)!) as typeof big;
  expect(out.type).toBe('message_end');
  expect(out.message.content[0].text.length).toBe(5000);
  expect(d.isReassembling).toBe(false);
});

test('multibyte text survives a chunk boundary', () => {
  const frame = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '→café—日本語'.repeat(200) }] } };
  const d = new RpcFrameDecoder();
  let out;
  for (const c of chunkify(frame, 7)) out = d.push(c);
  expect((out as typeof frame).message.content[0].text).toBe(frame.message.content[0].text);
});

test('rejects an interrupted sequence rather than emitting a corrupt frame', () => {
  const d = new RpcFrameDecoder();
  d.push(chunkify({ type: 'x', big: 'y'.repeat(400) }, 3)[0]);
  expect(() => d.push({ type: 'agent_end' })).toThrow(OmpRpcProtocolError);
});

test('rejects out-of-order chunks', () => {
  const d = new RpcFrameDecoder();
  const chunks = chunkify({ type: 'x', big: 'y'.repeat(400) }, 3);
  d.push(chunks[0]);
  expect(() => d.push(chunks[2])).toThrow(/out of order/);
});

test('rejects a sequence that does not start at index zero', () => {
  const d = new RpcFrameDecoder();
  expect(() => d.push(chunkify({ type: 'x', big: 'y'.repeat(400) }, 3)[1])).toThrow(/index zero/);
});

test('enforces the reassembly limit', () => {
  const d = new RpcFrameDecoder({ maxReassembledBytes: 128 });
  expect(() => d.push(chunkify({ type: 'x', big: 'y'.repeat(4000) }, 2)[0])).toThrow(/reassembly limit/);
});

test('parseFrame rejects malformed input', () => {
  expect(() => parseFrame('not json')).toThrow(/invalid JSON/);
  expect(() => parseFrame('[1,2]')).toThrow(/non-object/);
  expect(() => parseFrame('{"no":"type"}')).toThrow(/without a type/);
});
