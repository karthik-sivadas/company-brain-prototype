import { test, expect } from 'bun:test';
import { SlackRenderer } from '../src/slack/SlackRenderer.ts';

test('converts markdown to Slack mrkdwn', () => {
  expect(SlackRenderer.toMrkdwn('**bold**')).toBe('*bold*');
  expect(SlackRenderer.toMrkdwn('## Heading')).toBe('*Heading*');
  expect(SlackRenderer.toMrkdwn('[docs](https://x.dev)')).toBe('<https://x.dev|docs>');
});

test('never splits inside a fenced code block', () => {
  const fence = ['```sql', 'SELECT 1;'.repeat(60), '```'].join('\n');
  const chunks = SlackRenderer.chunk(`intro\n${fence}\noutro`, 120);
  const fenceCounts = chunks.map((c) => (c.match(/```/g) ?? []).length);
  // Every chunk must have balanced fences — an odd count means a code block was cut in half.
  for (const count of fenceCounts) expect(count % 2).toBe(0);
});

test('renders answer, context and feedback blocks', () => {
  const out = new SlackRenderer().render('The answer is **42**.', {
    tools: ['search_knowledge', 'query_table'], elapsedMs: 12_400, threadKey: 'T:C:1',
  });
  const types = out.blocks.map((b) => (b as { type: string }).type);
  expect(types).toContain('section');
  expect(types).toContain('context');
  expect(types).toContain('actions');
  const context = JSON.stringify(out.blocks.find((b) => (b as { type: string }).type === 'context'));
  expect(context).toContain('2 tool calls');
  expect(context).toContain('12s');
});

test('long answers overflow to a file instead of being truncated silently', () => {
  const long = 'x'.repeat(20_000);
  const out = new SlackRenderer().render(long, { tools: [], elapsedMs: 1000, threadKey: 'T:C:1' });
  expect(out.overflow).toBe(long);
  expect(JSON.stringify(out.blocks)).toContain('full answer attached');
});

test('empty answers are visible rather than blank', () => {
  const out = new SlackRenderer().render('', { tools: [], elapsedMs: 10, threadKey: 'T:C:1' });
  expect(JSON.stringify(out.blocks)).toContain('no text');
});

test('Slack control characters in agent output are escaped, not posted as live mentions', () => {
  // An answer that quotes a mention must not ping anyone — and must not ping the bot,
  // whose own posts are filtered by bot_id, not by text.
  const rendered = new SlackRenderer().render('The owner is <@U123> per <!channel>', {
    tools: [], elapsedMs: 1000, threadKey: 'T:C:1',
  });
  const text = JSON.stringify(rendered.blocks);
  expect(text).toContain('&lt;@U123&gt;');
  expect(text).not.toContain('<@U123>');
  expect(rendered.fallbackText).not.toContain('<@U123>');
});

test('markdown links still render after escaping', () => {
  expect(SlackRenderer.toMrkdwn('see [the issue](https://x/1)')).toBe('see <https://x/1|the issue>');
});

test('an ampersand is escaped once, not double-escaped', () => {
  expect(SlackRenderer.toMrkdwn('Tom & Jerry')).toBe('Tom &amp; Jerry');
});
