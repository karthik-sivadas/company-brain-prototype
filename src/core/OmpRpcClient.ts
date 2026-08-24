import type { Readable, Writable } from 'node:stream';

/** Frames OMP emits. Verified against omp v17.4.0 `--mode rpc` (protocolVersion 1). */
export type OmpFrame =
  | { type: 'ready'; protocolVersion: number; maxFrameBytes: number }
  | { type: 'response'; command: string; success: boolean; error?: string }
  | { type: 'agent_start' | 'turn_start' | 'turn_end' | 'agent_end' | 'message_start' }
  | { type: 'message_update'; assistantMessageEvent?: AssistantEvent }
  | { type: 'message_end'; message?: { role: string; content?: Array<{ type: string; text?: string }> } }
  | { type: string; [key: string]: unknown };

export type AssistantEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call_start'; toolName?: string; id?: string }
  | { type: 'tool_result'; id?: string }
  | { type: string; [key: string]: unknown };

export interface TurnEvents {
  onText?: (delta: string) => void;
  onTool?: (name: string) => void;
  onFrame?: (frame: OmpFrame) => void;
}

export interface TurnResult {
  text: string;
  tools: string[];
}

/**
 * Speaks OMP's newline-delimited JSON RPC protocol.
 *
 * Deliberately transport-agnostic: it takes a stdin/stdout pair, so the same client drives a
 * local `omp --mode rpc` process or one running inside a container via `docker exec -i`.
 *
 * Protocol (observed): the agent emits `ready`, then for each `{type:'prompt'}` written to
 * stdin it replies `response` → `agent_start` → `turn_start` → `message_*` → `agent_end`.
 */
export class OmpRpcClient {
  private buffer = '';
  private readonly waiters: Array<(frame: OmpFrame) => boolean> = [];

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly onUnhandled?: (frame: OmpFrame) => void,
  ) {
    stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame: OmpFrame;
      try { frame = JSON.parse(line) as OmpFrame; } catch { continue; } // ignore non-JSON banner lines
      this.dispatch(frame);
    }
  }

  private dispatch(frame: OmpFrame): void {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      if (this.waiters[i](frame)) this.waiters.splice(i, 1);
    }
    this.onUnhandled?.(frame);
  }

  /** Resolves once the agent announces it is ready to accept prompts. */
  waitForReady(timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('omp did not become ready in time')), timeoutMs);
      this.waiters.push((frame) => {
        if (frame.type !== 'ready') return false;
        clearTimeout(timer);
        resolve();
        return true;
      });
    });
  }

  /** Sends one prompt and resolves when the agent finishes the turn. */
  prompt(message: string, events: TurnEvents = {}, timeoutMs = 600_000): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      let text = '';
      const tools: string[] = [];
      const timer = setTimeout(() => reject(new Error('omp turn timed out')), timeoutMs);

      this.waiters.push((frame) => {
        events.onFrame?.(frame);

        if (frame.type === 'response' && (frame as { command?: string }).command === 'prompt') {
          const failed = (frame as { success?: boolean }).success === false;
          if (failed) {
            clearTimeout(timer);
            reject(new Error((frame as { error?: string }).error ?? 'omp rejected the prompt'));
            return true;
          }
        }

        if (frame.type === 'message_update') {
          const event = (frame as { assistantMessageEvent?: AssistantEvent }).assistantMessageEvent;
          if (event?.type === 'text_delta' && typeof event.delta === 'string') {
            text += event.delta;
            events.onText?.(event.delta);
          }
          if (event?.type === 'tool_call_start') {
            const name = String((event as { toolName?: string }).toolName ?? 'tool');
            tools.push(name);
            events.onTool?.(name);
          }
        }

        // The assistant's own message_end carries the authoritative final text.
        if (frame.type === 'message_end') {
          const msg = (frame as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } }).message;
          if (msg?.role === 'assistant') {
            const block = msg.content?.find((c) => c.type === 'text' && typeof c.text === 'string');
            if (block?.text) text = block.text;
          }
        }

        if (frame.type === 'agent_end') {
          clearTimeout(timer);
          resolve({ text: text.trim(), tools });
          return true;
        }
        return false;
      });

      this.stdin.write(`${JSON.stringify({ type: 'prompt', message })}\n`);
    });
  }

  abort(): void {
    this.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`);
  }
}
