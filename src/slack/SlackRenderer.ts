/** Slack message limits that matter when posting an agent answer. */
const SECTION_TEXT_LIMIT = 2900;   // Slack's cap is 3000; leave headroom
const TOTAL_TEXT_LIMIT = 11_500;   // beyond this, attach the answer as a file instead

export interface RenderedAnswer {
  blocks: unknown[];
  fallbackText: string;
  /** Set when the answer was too long for blocks; upload this as a snippet. */
  overflow?: string;
}

/**
 * Turns an agent answer into Block Kit.
 *
 * Slack's mrkdwn is not Markdown: `**bold**` must become `*bold*`, and there are no tables.
 * Long answers are split across section blocks, and anything past the total limit is attached
 * as a file rather than silently truncated.
 */
export class SlackRenderer {
  /**
   * Slack treats `<…>` as control sequences, so agent output must be escaped before any
   * rewrite. Unescaped, an answer that merely quotes `<@U123>` or `<!channel>` posts a
   * live mention — and a quoted mention of the bot itself is not filtered anywhere,
   * because our own posts are excluded by bot_id, not by text.
   *
   * Escaping runs first; the link rewrite below re-emits genuine `<…>` afterwards.
   * https://docs.slack.dev/messaging/formatting-message-text
   */
  static escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  static toMrkdwn(markdown: string): string {
    return SlackRenderer.escape(markdown)
      .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')          // headings → bold
      .replace(/\*\*(.+?)\*\*/g, '*$1*')             // bold
      .replace(/(^|[\s(])_(?!_)(.+?)_(?=[\s).,!?]|$)/g, '$1_$2_') // italics pass through
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>'); // links
  }

  /** Splits text into block-sized pieces without cutting inside a fenced code block. */
  static chunk(text: string, limit = SECTION_TEXT_LIMIT): string[] {
    const chunks: string[] = [];
    let current = '';
    let inFence = false;
    for (const line of text.split('\n')) {
      const isFenceMarker = line.trimStart().startsWith('```');
      // Decide using the state *before* this line: a closing ``` would otherwise flip the flag
      // and let the split land between the code and its own closing fence.
      const wasInFence = inFence;
      if (isFenceMarker) inFence = !inFence;

      const candidate = current ? `${current}\n${line}` : line;
      const splittable = !wasInFence && !inFence && !isFenceMarker;
      if (candidate.length > limit && current && splittable) {
        chunks.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  render(answer: string, meta: { tools: string[]; elapsedMs: number; threadKey: string }): RenderedAnswer {
    const mrkdwn = SlackRenderer.toMrkdwn(answer.trim() || '_(the agent returned no text)_');
    const tooLong = mrkdwn.length > TOTAL_TEXT_LIMIT;
    const body = tooLong ? `${mrkdwn.slice(0, TOTAL_TEXT_LIMIT)}\n\n_…full answer attached._` : mrkdwn;

    const blocks: unknown[] = SlackRenderer.chunk(body).map((text) => ({
      type: 'section', text: { type: 'mrkdwn', text },
    }));

    const seconds = Math.round(meta.elapsedMs / 1000);
    const toolSummary = meta.tools.length
      ? `${meta.tools.length} tool call${meta.tools.length === 1 ? '' : 's'}: ${[...new Set(meta.tools)].slice(0, 5).join(', ')}`
      : 'no tools used';
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${toolSummary} · ${seconds}s` }],
    });
    blocks.push({
      type: 'actions',
      block_id: `brain_actions:${meta.threadKey}`,
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '👍' }, action_id: 'brain_feedback_up', value: meta.threadKey },
        { type: 'button', text: { type: 'plain_text', text: '👎' }, action_id: 'brain_feedback_down', value: meta.threadKey },
      ],
    });

    return {
      blocks,
      fallbackText: SlackRenderer.escape(answer.slice(0, 500)) || 'Company Brain answered',
      overflow: tooLong ? answer : undefined,
    };
  }

  error(message: string): RenderedAnswer {
    return {
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${SlackRenderer.toMrkdwn(message)}` } }],
      fallbackText: SlackRenderer.escape(message.slice(0, 300)),
    };
  }
}
