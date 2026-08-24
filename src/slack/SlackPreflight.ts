/**
 * Preflight checks that a bot token can satisfy on its own.
 *
 * `slack doctor` used to check only that the tokens started with the right prefix,
 * which passes for any well-formed string. These calls talk to Slack and are all
 * read-only: nothing is posted, nothing is mutated.
 */

const SLACK_API = 'https://slack.com/api';

/** Scopes the bridge exercises today, each tied to the call that needs it. */
export const REQUIRED_BOT_SCOPES: Record<string, string> = {
  'app_mentions:read': 'receive app_mention — how a thread starts',
  'chat:write': 'chat.postMessage — post the answer',
  'reactions:write': 'reactions.add/remove — the hourglass→check progress marks',
  'files:write': 'files.uploadV2 — answers past Slack’s block limits',
  'channels:history': 'receive message.channels — follow-ups without an @mention',
  'im:history': 'receive message.im — DMs',
};

/** Declared in the manifest for features not built yet. Absence is not an error. */
export const OPTIONAL_BOT_SCOPES: Record<string, string> = {
  'groups:history': 'follow-ups in private channels',
  'channels:read': 'resolve channel names (doctor uses this)',
  'groups:read': 'list private channels (doctor uses this)',
  'im:write': 'open a DM conversation',
  'im:read': 'list DM conversations (`slack doctor` membership check)',
  'users:read': 'map Slack users to people (identity, not built yet)',
  'assistant:write': 'native streaming via sayStream (S6, optional)',
};

export interface BotIdentity {
  team: string;
  teamId: string;
  botUser: string;
  botId: string;
  userId: string;
  url: string;
}

export interface BotTokenResult {
  ok: boolean;
  error?: string;
  identity?: BotIdentity;
  granted: string[];
  /** True when Slack sent no x-oauth-scopes header, so the scope diff is not meaningful. */
  scopesUnknown: boolean;
  missingRequired: string[];
  missingOptional: string[];
}

/** Slack names the scope it wanted on a missing_scope error — quoting it saves a guess. */
function describeError(body: Record<string, unknown>): string {
  const error = String(body.error ?? 'unknown');
  if (error !== 'missing_scope') return error;
  const needed = body.needed ? ` (needs ${String(body.needed)})` : '';
  return `${error}${needed}`;
}

function readIdentity(body: Record<string, unknown>): BotIdentity {
  return {
    team: String(body.team ?? ''),
    teamId: String(body.team_id ?? ''),
    botUser: String(body.user ?? ''),
    botId: String(body.bot_id ?? ''),
    userId: String(body.user_id ?? ''),
    url: String(body.url ?? ''),
  };
}

async function call(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<{ body: Record<string, unknown>; scopes: string[] | undefined }> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API}/${method}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Absent header and "granted nothing" are different facts. Collapsing them made the
  // doctor report all six required scopes missing and tell the user to reinstall.
  const header = res.headers.get('x-oauth-scopes');
  const scopes = header === null
    ? undefined
    : header.split(',').map((s) => s.trim()).filter(Boolean);
  const body = (await res.json()) as Record<string, unknown>;
  return { body, scopes };
}

/**
 * Validates the bot token and reports which scopes Slack actually granted.
 *
 * The granted set comes from the `x-oauth-scopes` response header rather than
 * from the manifest, so it reflects what was installed — a manifest edit that
 * was never reinstalled shows up here as a missing scope.
 */
export async function checkBotToken(token: string): Promise<BotTokenResult> {
  if (!token) return { ok: false, error: 'no token', granted: [], scopesUnknown: true, missingRequired: Object.keys(REQUIRED_BOT_SCOPES), missingOptional: [] };

  let body: Record<string, unknown>;
  let granted: string[];
  try {
    ({ body, scopes: granted } = await call(token, 'auth.test'));
  } catch (err) {
    return { ok: false, error: `could not reach Slack: ${(err as Error).message}`, granted: [], scopesUnknown: true, missingRequired: [], missingOptional: [] };
  }

  if (body.ok !== true) {
    return {
      ok: false,
      error: describeError(body),
      granted: granted ?? [],
      scopesUnknown: granted === undefined,
      missingRequired: Object.keys(REQUIRED_BOT_SCOPES),
      missingOptional: [],
    };
  }

  // With no scope header there is nothing to diff; claiming everything is missing is worse
  // than admitting we could not tell.
  if (granted === undefined) {
    return {
      ok: true,
      granted: [],
      scopesUnknown: true,
      identity: readIdentity(body),
      missingRequired: [],
      missingOptional: [],
    };
  }

  const has = new Set(granted);
  return {
    ok: true,
    granted,
    scopesUnknown: false,
    identity: readIdentity(body),
    missingRequired: Object.keys(REQUIRED_BOT_SCOPES).filter((s) => !has.has(s)),
    missingOptional: Object.keys(OPTIONAL_BOT_SCOPES).filter((s) => !has.has(s)),
  };
}

export interface ChannelMembership {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
}

/**
 * Lists the conversations the bot is actually a member of.
 *
 * Uses `users.conversations`, not `conversations.list`. Slack returns "fewer than the
 * requested number of items ... even if the end of the list hasn't been reached", so a
 * single unpaginated conversations.list page could miss the invited channel entirely and
 * report "the bot is in no channel" on a healthy install. users.conversations returns
 * only conversations the app has joined — a small set, same scopes, cheaper rate limit —
 * so membership is answered directly rather than inferred from is_member.
 *
 * A bot in no conversation receives no events at all, which reads to a first-time user
 * as a hang.
 */
export async function checkMembership(
  token: string,
  granted: string[],
): Promise<ChannelMembership[] | { error: string }> {
  const types: string[] = [];
  if (granted.includes('channels:read')) types.push('public_channel');
  if (granted.includes('groups:read')) types.push('private_channel');
  // Listing DM conversations needs im:read; im:history only grants reading their messages.
  if (granted.includes('im:read')) types.push('im');
  if (types.length === 0) return { error: 'needs channels:read (and groups:read for private channels)' };

  const found: ChannelMembership[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const params: Record<string, string> = {
      types: types.join(','), limit: '200', exclude_archived: 'true',
    };
    if (cursor) params.cursor = cursor;
    const { body } = await call(token, 'users.conversations', params);
    if (body.ok !== true) return { error: describeError(body) };

    for (const c of (body.channels ?? []) as Array<Record<string, unknown>>) {
      found.push({
        id: String(c.id ?? ''),
        name: String(c.name ?? (c.is_im ? 'direct message' : '')),
        isMember: true, // users.conversations only returns joined conversations
        isPrivate: c.is_private === true,
      });
    }
    cursor = String((body.response_metadata as { next_cursor?: string })?.next_cursor ?? '');
    if (!cursor) break;
  }
  return found;
}

export interface AppTokenResult {
  ok: boolean;
  error?: string;
  hint?: string;
}

/**
 * Validates the app-level token by asking for a Socket Mode connection URL.
 *
 * `apps.connections.open` is the first step of the Socket Mode handshake. It
 * returns a single-use WSS URL and we deliberately never connect to it — the
 * point is that a successful response proves three things at once: the token is
 * valid, it carries `connections:write`, and Socket Mode is enabled on the app.
 */
export async function checkAppToken(token: string): Promise<AppTokenResult> {
  if (!token) return { ok: false, error: 'no token' };
  let body: Record<string, unknown>;
  try {
    const res = await fetch(`${SLACK_API}/apps.connections.open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '', // a form content-type with no body; match what the SDK sends
    });
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `could not reach Slack: ${(err as Error).message}` };
  }

  if (body.ok === true) return { ok: true };

  const error = String(body.error ?? 'unknown');
  // Only strings that appear in Slack's documented error table for this method.
  const hints: Record<string, string> = {
    invalid_auth: 'the xapp- token is wrong or was revoked',
    not_allowed_token_type: 'that looks like a bot token — Socket Mode needs the app-level xapp- token',
    missing_scope: 'the app-level token needs the connections:write scope',
    missing_args: 'no app-level token was sent',
    insecure_request: 'the request must be a POST over https',
    invalid_arg_name: 'unexpected argument sent to apps.connections.open',
  };
  return { ok: false, error, hint: hints[error] };
}
