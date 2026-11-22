/**
 * ICE REST API (v0.1, Slice A) — Hono.
 *
 * Implements the v0.1 wire contract:
 *   GET  /api/health                         -> { status: 'ok' }
 *   POST /api/auth/register {email,password,displayName} -> { user } + cookie
 *   POST /api/auth/login    {email,password}             -> { user } + cookie
 *   POST /api/auth/guest    {displayName}                -> { participant }
 *   GET  /api/auth/me                                     -> { user } | 401
 *   POST /api/auth/logout                                 -> { ok } (clears cookie)
 *   POST /api/rooms {name}                                -> { room }
 *   POST /api/rooms/:roomId/invites                       -> { token, url }
 *   POST /api/rooms/:roomId/access {inviteToken?}         -> { roomToken, room, participant }
 *
 * Auth is permissive by design in dev: room creation / access work for guests so
 * the two-browser live-editing demo needs no signup. The session cookie is
 * httpOnly; room access is granted via a short-lived room JWT the web client
 * hands to the `/sync` WebSocket.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type {
  AgentBackendKind,
  AgentConfig,
  AgentPolicy,
  AgentState,
  ApprovalDecision,
  Participant,
  Room,
} from '@ice/shared';
import {
  IS_PRODUCTION,
  PUBLIC_URL,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  INVITE_TTL_SECONDS,
} from './config.js';
import {
  colorFor,
  guestParticipant,
  hashPassword,
  newInviteToken,
  participantForUser,
  signRoomToken,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
  type SessionClaims,
} from './auth.js';
import {
  createInvite,
  createRoom,
  createUser,
  findInviteByToken,
  findRoomById,
  findUserByEmail,
  findUserById,
  toUserAccount,
  type InviteRow,
  type UserRow,
} from './db.js';
import { flushAndCommit, getChanges, getFileVersions, listBranches, listCommits, loadRoomFromGit } from './convergence/index.js';
import * as github from './github/github.js';
import { getHocuspocus } from './realtime.js';
import { getSharedTerminalRunner } from './terminal/shared.js';
import { MAX_CONVERT_CHARS, checkApiStatus, convertCode, getApiStatus, isConvertLang } from './convert/convert.js';
import { AssistError, MAX_ASSIST_PROMPT_CHARS, runAssist } from './assist/assist.js';
import { startAgentForRoom,handleAgentMessage, resolveApproval } from './agent/index.js';
import { getRoomDoc } from './room-doc.js';
import { makeVoiceTokenHandler } from './voice/index.js';
import { startOrchestration, interruptOrchestration } from './orchestrator/index.js';
import {
  createAgentSnapshot,
  mergeSnapshot,
  discardSnapshot,
  snapshotStore,
} from './agent-policy/index.js';
import { makeMcpRoutes } from './mcp/index.js';
import { policies, mcpRegistry } from './v15.js';
import { makeAuditRoutes, recordAudit } from './audit/index.js';

/** Per-request state we hang off the Hono context. */
type Env = {
  Variables: {
    session?: SessionClaims;
  };
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Set the httpOnly session cookie. */
function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PRODUCTION,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function createApiApp(): Hono<Env> {
  const app = new Hono<Env>();

  // Permissive CORS so the Vite dev origin can call the API with credentials.
  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin ?? PUBLIC_URL,
      credentials: true,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  // Resolve the session cookie (if any) onto the context for downstream routes.
  app.use('/api/*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const claims = await verifySessionToken(token);
      if (claims) c.set('session', claims);
    }
    await next();
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/api/health', (c) => c.json({ status: 'ok' as const }));

  // ── Auth ──────────────────────────────────────────────────────────────────
  app.post('/api/auth/register', async (c) => {
    const body = await readJson(c);
    const email = asString(body.email)?.trim().toLowerCase() ?? '';
    const password = asString(body.password) ?? '';
    const displayName = asString(body.displayName)?.trim() ?? '';

    if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);
    if (password.length < 8) return c.json({ error: 'weak_password' }, 400);
    if (displayName.length === 0) return c.json({ error: 'missing_display_name' }, 400);
    if (findUserByEmail(email)) return c.json({ error: 'email_taken' }, 409);

    const user: UserRow = {
      id: `user_${randomUUID()}`,
      email,
      displayName,
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
    };
    createUser(user);

    const token = await signSessionToken(user);
    setSessionCookie(c, token);
    return c.json({ user: toUserAccount(user) }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const body = await readJson(c);
    const email = asString(body.email)?.trim().toLowerCase() ?? '';
    const password = asString(body.password) ?? '';

    const user = findUserByEmail(email);
    // Run a verify even on miss to keep timing roughly uniform.
    const ok = user
      ? verifyPassword(password, user.passwordHash)
      : verifyPassword(password, 'scrypt:16384:8:1:00:00');
    if (!user || !ok) return c.json({ error: 'invalid_credentials' }, 401);

    const token = await signSessionToken(user);
    setSessionCookie(c, token);
    return c.json({ user: toUserAccount(user) });
  });

  app.post('/api/auth/guest', async (c) => {
    const body = await readJson(c);
    const displayName = asString(body.displayName)?.trim() ?? '';
    const participant: Participant = guestParticipant(displayName);
    return c.json({ participant });
  });

  app.get('/api/auth/me', (c) => {
    const session = c.get('session');
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    const user = findUserById(session.sub);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    return c.json({ user: toUserAccount(user) });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ── Rooms ───────────────────────────────────────────────────────────────────
  app.post('/api/rooms', async (c) => {
    const body = await readJson(c);
    const name = asString(body.name)?.trim() || 'Untitled room';
    const session = c.get('session');

    const room: Room = { id: `room_${randomUUID()}`, name, createdAt: Date.now() };
    createRoom(room, session?.sub ?? null);
    return c.json({ room }, 201);
  });

  app.post('/api/rooms/:roomId/invites', async (c) => {
    const roomId = c.req.param('roomId');
    const room = findRoomById(roomId);
    if (!room) return c.json({ error: 'room_not_found' }, 404);

    const session = c.get('session');
    const createdBy = session?.sub ?? 'anonymous';
    const invite: InviteRow = {
      token: newInviteToken(),
      roomId,
      createdBy,
      expiresAt: Date.now() + INVITE_TTL_SECONDS * 1000,
      createdAt: Date.now(),
    };
    createInvite(invite);

    const url = `${PUBLIC_URL}/r/${encodeURIComponent(roomId)}?invite=${encodeURIComponent(
      invite.token,
    )}`;
    return c.json({ token: invite.token, url }, 201);
  });

  app.post('/api/rooms/:roomId/access', async (c) => {
    const roomId = c.req.param('roomId');
    const body = await readJson(c);
    const inviteToken = asString(body.inviteToken);

    let room = findRoomById(roomId);

    // An invite token both authorises access and (in dev) bootstraps the room
    // row if it referenced a room we have not persisted yet.
    if (inviteToken) {
      const invite = findInviteByToken(inviteToken);
      if (!invite || invite.roomId !== roomId) {
        return c.json({ error: 'invalid_invite' }, 403);
      }
      if (invite.expiresAt != null && invite.expiresAt < Date.now()) {
        return c.json({ error: 'invite_expired' }, 403);
      }
    } else if (!room && IS_PRODUCTION) {
      // In production a room must exist and access needs an invite (or, later,
      // membership). Dev stays permissive so the demo flows.
      return c.json({ error: 'room_not_found' }, 404);
    }

    // Lazily materialise the room in dev so a freshly-created room id always
    // yields a working session.
    if (!room) {
      room = { id: roomId, name: 'Untitled room', createdAt: Date.now() };
      createRoom(room, null);
    }

    // Identify the participant: logged-in user, else a guest.
    const session = c.get('session');
    let participant: Participant;
    if (session) {
      const user = findUserById(session.sub);
      participant = user
        ? participantForUser(user)
        : guestParticipant(session.name);
    } else {
      const displayName = asString(body.displayName)?.trim() ?? '';
      participant = guestParticipant(displayName);
    }

    const roomToken = await signRoomToken(roomId, participant);
    return c.json({ roomToken, room, participant });
  });

  // ── Git / source control (v0.3) ───────────────────────────────────────────────
  // Flush the LIVE doc (the one Hocuspocus has open) into a commit on the room's
  // bundled git repo. Yjs is the source of truth; this projects it into git.
  app.post('/api/rooms/:roomId/commit', async (c) => {
    const roomId = c.req.param('roomId');
    const body = await readJson(c);
    const message = asString(body.message)?.trim() || 'Update from ICE';

    // Author from the session when available, else a sensible default.
    let authorName = 'ICE user';
    let authorEmail = 'user@ice.local';
    const session = c.get('session');
    if (session) {
      const user = findUserById(session.sub);
      if (user) {
        authorName = user.displayName;
        authorEmail = user.email;
      } else if (session.name) {
        authorName = session.name;
      }
    }

    const conn = await getHocuspocus().openDirectConnection(roomId);
    try {
      if (!conn.document) return c.json({ error: 'room_unavailable' }, 503);
      const result = await flushAndCommit(roomId, conn.document, {
        message,
        authorName,
        authorEmail,
      });
      recordAudit(conn.document, roomId, {
        actor: { kind: 'human', id: session?.sub ?? authorName, name: authorName },
        action: 'commit',
        detail: `${result.hash.slice(0, 8)} ${message}`,
      });
      return c.json(result);
    } finally {
      await conn.disconnect();
    }
  });

  app.get('/api/rooms/:roomId/branches', async (c) => {
    const branches = await listBranches(c.req.param('roomId'));
    return c.json({ branches });
  });

  app.get('/api/rooms/:roomId/commits', async (c) => {
    const ref = c.req.query('branch') || undefined;
    const limitRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const commits = await listCommits(c.req.param('roomId'), { ref, limit });
    return c.json({ commits });
  });

  // ── GitHub / source control from the IDE ──────────────────────────────────────
  // status = what changed vs the last commit + sync state; remote = connect a
  // GitHub repo (token stays server-side); push / pull (fast-forward) / publish.
  const githubFail = (c: Context, err: unknown) => {
    if (err instanceof github.GithubError) {
      const status =
        err.code === 'auth_failed' || err.code === 'no_token' ? 401
        : err.code === 'not_found' ? 404
        : err.code === 'rejected' || err.code === 'diverged' || err.code === 'dirty' || err.code === 'exists' ? 409
        : err.code === 'invalid_remote' || err.code === 'no_remote' || err.code === 'no_commits' ? 400
        : 502;
      return c.json({ error: err.code, message: err.message }, status);
    }
    return c.json({ error: 'failed', message: 'Something went wrong. Please try again.' }, 500);
  };
  const needSession = (c: Context): boolean => IS_PRODUCTION && !c.get('session');

  app.get('/api/rooms/:roomId/git/status', async (c) => {
    const roomId = c.req.param('roomId');
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    try {
      const [changes, sync, remote] = await Promise.all([
        getChanges(roomId, doc),
        github.syncStatus(roomId),
        github.getRemote(roomId),
      ]);
      return c.json({ changes, ...sync, remote });
    } catch (err) {
      return githubFail(c, err);
    }
  });

  app.get('/api/rooms/:roomId/git/diff', async (c) => {
    const roomId = c.req.param('roomId');
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'invalid_request' }, 400);
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    return c.json(await getFileVersions(roomId, doc, p));
  });

  app.put('/api/rooms/:roomId/git/remote', async (c) => {
    if (needSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    const body = await readJson(c);
    try {
      return c.json(
        await github.setRemote(c.req.param('roomId'), {
          url: asString(body.url) ?? undefined,
          token: asString(body.token) ?? undefined,
        }),
      );
    } catch (err) {
      return githubFail(c, err);
    }
  });

  app.delete('/api/rooms/:roomId/git/remote', async (c) => {
    if (needSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    await github.clearRemote(c.req.param('roomId'));
    return c.json({ ok: true });
  });

  app.post('/api/rooms/:roomId/git/push', async (c) => {
    if (needSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    try {
      return c.json(await github.push(c.req.param('roomId')));
    } catch (err) {
      return githubFail(c, err);
    }
  });

  app.post('/api/rooms/:roomId/git/pull', async (c) => {
    if (needSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    const roomId = c.req.param('roomId');
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    try {
      return c.json(await github.pull(roomId, doc));
    } catch (err) {
      return githubFail(c, err);
    }
  });

  app.post('/api/rooms/:roomId/git/publish', async (c) => {
    if (needSession(c)) return c.json({ error: 'unauthenticated' }, 401);
    const body = await readJson(c);
    try {
      return c.json(
        await github.createRepo(c.req.param('roomId'), {
          name: asString(body.name) ?? '',
          private: body.private !== false,
          description: asString(body.description) ?? undefined,
        }),
      );
    } catch (err) {
      return githubFail(c, err);
    }
  });

  // ── Agents (v0.5) ─────────────────────────────────────────────────────────────
  // Add an AI teammate (defaults to the dependency-free 'mock' backend). The
  // authoritative agent state + chat stream back through the Yjs doc
  // (getAgents / getAgentChat); these routes are just the command surface.
  app.post('/api/rooms/:roomId/agent', async (c) => {
    const roomId = c.req.param('roomId');
    const body = await readJson(c);
    const kind =
      (asString(body.kind) as AgentBackendKind) ||
      (process.env.ICE_DEFAULT_AGENT_KIND as AgentBackendKind | undefined) ||
      'mock';
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);

    const agentId = `agent_${randomUUID()}`;
    const displayName =
      kind === 'claude-code'
        ? 'Claude'
        : kind === 'codex'
          ? 'Codex'
          : kind === 'gemini'
            ? 'Gemini'
            : 'Mock Agent';
    const config: AgentConfig = { agentId, kind, displayName };
    await startAgentForRoom(roomId, doc, config);

    const agent: AgentState = { agentId, kind, displayName, color: colorFor(agentId), status: 'idle' };
    return c.json({ agent }, 201);
  });

  // Relay a human prompt; the agent's reply streams into getAgentChat(doc).
  app.post('/api/rooms/:roomId/agent/message', async (c) => {
    const roomId = c.req.param('roomId');
    const body = await readJson(c);
    const text = asString(body.text)?.trim() ?? '';
    if (!text) return c.json({ error: 'empty_message' }, 400);
    const agentId = asString(body.agentId) ?? undefined;
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    await handleAgentMessage(roomId, doc, text, agentId ? { agentId } : undefined);
    return c.json({ ok: true });
  });

  // Resolve the human approval gate for a pending tool call.
  app.post('/api/rooms/:roomId/agent/approve', async (c) => {
    const roomId = c.req.param('roomId');
    const body = await readJson(c);
    const callId = asString(body.callId) ?? '';
    const decision = asString(body.decision);
    if (!callId || (decision !== 'approve' && decision !== 'reject')) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const agentId = asString(body.agentId) ?? undefined;
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    const ok = await resolveApproval(
      roomId,
      callId,
      decision as ApprovalDecision,
      agentId ? { agentId } : undefined,
    );
    return c.json({ ok });
  });

  // ── Voice (v1.0) — LiveKit token. Media rides LiveKit; the server only mints
  // a short-lived room-join token (503s if LIVEKIT_* env is not configured).
  app.post(
    '/api/rooms/:roomId/voice/token',
    makeVoiceTokenHandler({
      identityResolver: (c) => {
        const session = c.get('session') as SessionClaims | undefined;
        if (!session) return null;
        const user = findUserById(session.sub);
        return user
          ? { identity: user.id, name: user.displayName }
          : { identity: session.sub, name: session.name ?? 'Guest' };
      },
    }),
  );

  // ── Multi-agent squad (v1.5) ──────────────────────────────────────────────────
  // Assign a task to a squad: the orchestrator plans subtasks + spawns specialist
  // agents that co-edit the room concurrently. Progress streams via getTasks(doc).
  app.post('/api/rooms/:roomId/orchestrate', async (c) => {
    const roomId = c.req.param('roomId');
    const body = await readJson(c);
    const prompt = asString(body.prompt)?.trim() ?? '';
    if (!prompt) return c.json({ error: 'empty_prompt' }, 400);
    const doc = await getRoomDoc(roomId);
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    await startOrchestration(roomId, doc, prompt);
    const session = c.get('session');
    recordAudit(doc, roomId, {
      actor: { kind: 'human', id: session?.sub ?? 'guest', name: session?.name },
      action: 'orchestrate',
      detail: prompt.slice(0, 100),
    });
    return c.json({ ok: true });
  });
  app.post('/api/rooms/:roomId/orchestrate/interrupt', (c) =>
    c.json({ ok: interruptOrchestration(c.req.param('roomId')) }),
  );

  // Per-agent permission policy (allow/deny tools + write paths; gate destructive).
  app.put('/api/rooms/:roomId/agents/:agentId/policy', async (c) => {
    const roomId = c.req.param('roomId');
    const agentId = c.req.param('agentId');
    const body = await readJson(c);
    const policy: AgentPolicy = {
      agentId,
      allowTools: Array.isArray(body.allowTools) ? (body.allowTools as string[]) : ['*'],
      denyTools: Array.isArray(body.denyTools) ? (body.denyTools as string[]) : [],
      writePaths: Array.isArray(body.writePaths) ? (body.writePaths as string[]) : [],
      denyPaths: Array.isArray(body.denyPaths) ? (body.denyPaths as string[]) : [],
      requireApprovalForDestructive: body.requireApprovalForDestructive !== false,
    };
    policies.set(roomId, policy);
    return c.json({ ok: true, policy });
  });
  app.get('/api/rooms/:roomId/agents/:agentId/policy', (c) =>
    c.json({ policy: policies.get(c.req.param('roomId'), c.req.param('agentId')) }),
  );

  // Opt-in snapshots ("try it safely"): an agent works on a branch, merge/discard.
  // The web client uses the singular `/snapshot` form; both are served.
  for (const seg of ['snapshots', 'snapshot']) {
    app.post(`/api/rooms/:roomId/${seg}`, async (c) => {
      const roomId = c.req.param('roomId');
      const body = await readJson(c);
      // No agent chosen (zero or several agents in the room): snapshot for the room.
      const agentId = asString(body.agentId)?.trim() || 'room';
      const doc = await getRoomDoc(roomId);
      if (!doc) return c.json({ error: 'room_unavailable' }, 503);
      try {
        const snapshot = await createAgentSnapshot(roomId, doc, agentId, {
          message: asString(body.message) ?? undefined,
        });
        return c.json({ snapshot });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'snapshot_failed' }, 500);
      }
    });
    app.post(`/api/rooms/:roomId/${seg}/:id/merge`, async (c) => {
      const roomId = c.req.param('roomId');
      const id = c.req.param('id');
      if (snapshotStore.roomFor(id) !== roomId) return c.json({ error: 'unknown_snapshot' }, 404);
      const doc = await getRoomDoc(roomId);
      if (!doc) return c.json({ error: 'room_unavailable' }, 503);
      try {
        const result = await mergeSnapshot(id);
        await loadRoomFromGit(roomId, doc); // surface the merged work to clients
        recordAudit(doc, roomId, {
          actor: { kind: 'system', id: 'snapshot' },
          action: 'snapshot-merge',
          detail: id,
        });
        return c.json({ ok: true, result });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'merge_failed' }, 409);
      }
    });
    app.post(`/api/rooms/:roomId/${seg}/:id/discard`, async (c) => {
      const id = c.req.param('id');
      if (snapshotStore.roomFor(id) !== c.req.param('roomId')) {
        return c.json({ error: 'unknown_snapshot' }, 404);
      }
      await discardSnapshot(id);
      return c.json({ ok: true });
    });
  }

  // Human input to the room's shared terminal. Runs on the server host, so in
  // production it requires a signed-in session; set ICE_TERMINAL_HUMAN_INPUT=0 to disable.
  app.post('/api/rooms/:roomId/terminal/run', async (c) => {
    if (process.env.ICE_TERMINAL_HUMAN_INPUT === '0') return c.json({ error: 'terminal_disabled' }, 403);
    if (IS_PRODUCTION && !c.get('session')) return c.json({ error: 'unauthenticated' }, 401);
    const runner = getSharedTerminalRunner();
    if (!runner) return c.json({ error: 'terminal_unavailable' }, 503);
    const body = await readJson(c);
    const command = asString(body.command)?.trim() ?? '';
    if (!command) return c.json({ error: 'empty_command' }, 400);
    if (command.length > 4000) return c.json({ error: 'command_too_long' }, 400);
    // Fire and forget: output streams into the shared Y.Text for everyone.
    void runner.runCommand(c.req.param('roomId'), command).catch(() => {});
    return c.json({ ok: true }, 202);
  });
  app.get('/api/rooms/:roomId/snapshots', (c) =>
    c.json({ snapshots: snapshotStore.list(c.req.param('roomId')) }),
  );

  // Code conversion (cpp/python/java/javascript). The response never says how
  // the result was produced; failures are one generic error.
  app.post('/api/convert', async (c) => {
    if (IS_PRODUCTION && !c.get('session')) return c.json({ error: 'unauthenticated' }, 401);
    const body = await readJson(c);
    const code = asString(body.code);
    if (code === null) return c.json({ error: 'invalid_request' }, 400);
    if (!isConvertLang(body.from) || !isConvertLang(body.to)) {
      return c.json({ error: 'unsupported_language' }, 400);
    }
    if (code.length > MAX_CONVERT_CHARS) return c.json({ error: 'file_too_large' }, 413);
    const converted = await convertCode(code, body.from, body.to);
    if (converted === null) return c.json({ error: 'conversion_failed' }, 502);
    return c.json({ code: converted });
  });
  // AI assistant (RAG): the open file + any @-referenced files go to Gemini with
  // "minimal change" rules; the corrected full file comes back for the client to diff.
  app.post('/api/rooms/:roomId/assist', async (c) => {
    if (IS_PRODUCTION && !c.get('session')) return c.json({ error: 'unauthenticated' }, 401);
    const body = await readJson(c);
    const prompt = asString(body.prompt)?.trim() ?? '';
    if (!prompt) return c.json({ error: 'empty_prompt' }, 400);
    if (prompt.length > MAX_ASSIST_PROMPT_CHARS) return c.json({ error: 'prompt_too_long' }, 413);
    const activePath = asString(body.activePath) ?? null;
    const doc = await getRoomDoc(c.req.param('roomId'));
    if (!doc) return c.json({ error: 'room_unavailable' }, 503);
    const files = new Map<string, string>();
    doc.getMap<{ toString(): string }>('files').forEach((text, path) => files.set(path, text.toString()));
    try {
      return c.json(await runAssist(prompt, activePath, files));
    } catch (err) {
      if (err instanceof AssistError) {
        const status = err.code === 'not_configured' ? 503 : err.code === 'too_large' ? 413 : err.code === 'no_file' ? 400 : 502;
        return c.json({ error: err.code, message: err.message }, status);
      }
      return c.json({ error: 'assist_failed', message: 'Something went wrong. Please try again.' }, 500);
    }
  });

  app.get('/api/convert/status', (c) => c.json(getApiStatus()));
  app.post('/api/convert/status/recheck', async (c) => {
    await checkApiStatus();
    return c.json(getApiStatus());
  });

  // Workspace MCP tool palette (GET /api/rooms/:roomId/mcp/tools).
  app.route('/', makeMcpRoutes({ provider: mcpRegistry, connections: mcpRegistry }));

  // Audit trail (v2.0): read-only GET /api/rooms/:roomId/audit.
  app.route('/', makeAuditRoutes({ resolveDoc: getRoomDoc }));

  // ── Fallback ────────────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    // eslint-disable-next-line no-console
    console.error('[ice] api error:', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

/** Tolerant JSON body reader: never throws on empty/invalid bodies. */
async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
