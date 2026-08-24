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
  missingRequired: string[];
  missingOptional: string[];
}

async function call(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<{ body: Record<string, unknown>; scopes: string[] }> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API}/${method}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const header = res.headers.get('x-oauth-scopes') ?? '';
  const scopes = header.split(',').map((s) => s.trim()).filter(Boolean);
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
  if (!token) return { ok: false, error: 'no token', granted: [], missingRequired: Object.keys(REQUIRED_BOT_SCOPES), missingOptional: [] };

  let body: Record<string, unknown>;
  let granted: string[];
  try {
    ({ body, scopes: granted } = await call(token, 'auth.test'));
  } catch (err) {
    return { ok: false, error: `could not reach Slack: ${(err as Error).message}`, granted: [], missingRequired: [], missingOptional: [] };
  }

  if (body.ok !== true) {
    return {
      ok: false,
      error: String(body.error ?? 'unknown'),
      granted,
      missingRequired: Object.keys(REQUIRED_BOT_SCOPES),
      missingOptional: [],
    };
  }

  const has = new Set(granted);
  return {
    ok: true,
    granted,
    identity: {
      team: String(body.team ?? ''),
      teamId: String(body.team_id ?? ''),
      botUser: String(body.user ?? ''),
      botId: String(body.bot_id ?? ''),
      userId: String(body.user_id ?? ''),
      url: String(body.url ?? ''),
    },
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
 * Lists channels the token can see, flagging membership.
 *
 * A bot that is not in any channel receives no events at all, which is the
 * single most common reason a first Slack test appears to hang.
 * Private channels are only listed when `groups:read` was granted, so this
 * asks for exactly the types the granted scopes allow.
 */
export async function checkMembership(token: string, granted: string[]): Promise<ChannelMembership[] | { error: string }> {
  const types: string[] = [];
  if (granted.includes('channels:read')) types.push('public_channel');
  if (granted.includes('groups:read')) types.push('private_channel');
  if (types.length === 0) return { error: 'needs channels:read (and groups:read for private channels)' };

  const { body } = await call(token, 'conversations.list', {
    types: types.join(','),
    limit: '200',
    exclude_archived: 'true',
  });
  if (body.ok !== true) return { error: String(body.error ?? 'unknown') };

  return ((body.channels ?? []) as Array<Record<string, unknown>>).map((c) => ({
    id: String(c.id ?? ''),
    name: String(c.name ?? ''),
    isMember: c.is_member === true,
    isPrivate: c.is_private === true,
  }));
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
    });
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `could not reach Slack: ${(err as Error).message}` };
  }

  if (body.ok === true) return { ok: true };

  const error = String(body.error ?? 'unknown');
  const hints: Record<string, string> = {
    invalid_auth: 'the xapp- token is wrong or was revoked',
    not_allowed_token_type: 'that looks like a bot token — Socket Mode needs the app-level xapp- token',
    missing_scope: 'the app-level token needs the connections:write scope',
    socket_mode_not_enabled: 'turn Socket Mode on in the app settings',
  };
  return { ok: false, error, hint: hints[error] };
}
