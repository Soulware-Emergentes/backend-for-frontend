import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oidc from 'openid-client';
import type { Config } from './config';
import { type ApiName, type Grant, type Session, Sessions } from './sessions';
import { type IdentityProvider, claimsOf } from './staff';

export const SESSION_COOKIE = 'sgt_session';
/** The cookie Angular's HttpClient reads the CSRF token from, and echoes back as {@link CSRF_HEADER}. */
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';
const CSRF_FIELD = '_csrf';

/** A token this close to expiring is renewed before it is sent on. */
const RENEW_BEFORE_MS = 30_000;

/** What staff answers a silent login with when only the person can complete it. */
const INTERACTION_REQUIRED = new Set([
  'login_required',
  'interaction_required',
  'consent_required',
  'account_selection_required',
]);

/** Request headers the browser sends the BFF that an API must not get. */
const HOP_HEADERS = ['cookie', 'authorization', 'host', 'connection', 'content-length', CSRF_HEADER];

export interface Dependencies {
  config: Config;
  staff: IdentityProvider;
  sessions: Sessions;
  now?: () => number;
}

/**
 * The BFF: sgt's web application logs in through it and calls its APIs through it, holding nothing
 * but a session cookie. It keeps the person's tokens, one per API since staff issues one per API,
 * renews them while the login lasts, and sends each request on with the one its API takes.
 *
 * - `/bff/login` and `/bff/callback`: the login, with staff, then a second, silent trip for the
 *   beneficiary registry's token.
 * - `/bff/me`: the claims of the person's tokens, which the SPA reads their roles from.
 * - `/bff/logout`: ends the session here and in staff.
 * - `/api/sgt/**` and `/api/beneficiarios/**`: each API, with its token.
 *
 * Without a session, or once the login has ended, the APIs and `/bff/me` answer 401.
 */
export function createApp({ config, staff, sessions, now = Date.now }: Dependencies): Hono {
  const app = new Hono();

  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'Lax', path: '/' } as const;

  const keep = (c: Context, session: Session): void => {
    const maxAge = Math.max(0, Math.floor((session.expiresAt - now()) / 1000));
    setCookie(c, SESSION_COOKIE, session.id, { ...cookieOptions, maxAge });
    setCookie(c, CSRF_COOKIE, session.csrfToken, { ...cookieOptions, httpOnly: false, maxAge });
  };

  const forget = (c: Context): void => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    deleteCookie(c, CSRF_COOKIE, { path: '/' });
  };

  const sessionOf = (c: Context): Session | null => sessions.find(getCookie(c, SESSION_COOKIE));

  /** Sends the browser to staff for `api`'s token, remembering what to do once it comes back. */
  const authorize = async (
    c: Context,
    session: Session,
    api: ApiName,
    returnUrl: string,
    silent: boolean,
    uiLocales: string | null,
  ): Promise<Response> => {
    const state = oidc.randomState();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    session.pending.set(state, { api, codeVerifier, returnUrl, silent, uiLocales, startedAt: now() });
    keep(c, session);

    const url = await staff.authorizationUrl({
      scope: config[api].scope,
      state,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      silent,
      uiLocales,
    });
    return c.redirect(url.toString(), 302);
  };

  /**
   * @returns a usable token for `api`, renewed when about to expire, or null when the session holds
   *          none or staff will no longer renew it
   */
  const grantFor = async (session: Session, api: ApiName): Promise<Grant | null> => {
    const grant = session.grants[api];
    if (!grant) {
      return null;
    }
    if (grant.expiresAt - RENEW_BEFORE_MS > now()) {
      return grant;
    }
    if (!grant.refreshToken) {
      delete session.grants[api];
      return null;
    }
    try {
      const renewed = await staff.refresh(grant.refreshToken);
      session.grants[api] = renewed.grant;
      if (renewed.idToken) {
        session.idToken = renewed.idToken;
      }
      return renewed.grant;
    } catch (error) {
      console.error(`Staff refused to renew the ${api} token:`, error);
      delete session.grants[api];
      return null;
    }
  };

  /** @returns the session of a logged-in person, ending it once sgt's token can no longer be renewed */
  const loggedIn = async (c: Context): Promise<Session | null> => {
    const session = sessionOf(c);
    if (!session) {
      return null;
    }
    if (!(await grantFor(session, 'sgt'))) {
      sessions.end(session);
      return null;
    }
    return session;
  };

  const unauthenticated = (c: Context): Response => {
    forget(c);
    return c.json({ code: 'unauthenticated' }, 401);
  };

  app.get('/bff/login', async (c) => {
    const returnUrl = withinTheSpa(c.req.query('returnUrl'));
    const silent = c.req.query('prompt') === 'none';
    const session = sessionOf(c) ?? sessions.open();

    return authorize(c, session, 'sgt', returnUrl, silent, c.req.query('ui_locales') ?? null);
  });

  app.get('/bff/callback', async (c) => {
    const session = sessionOf(c);
    const state = c.req.query('state') ?? '';
    const pending = session?.pending.get(state);
    if (!session || !pending) {
      console.error(session ? 'A callback answered no login this session asked for' : 'A callback came without a session');
      return c.redirect('/sign-in-failed', 302);
    }
    session.pending.delete(state);
    const callbackUrl = new URL(`${config.publicUrl}/bff/callback${new URL(c.req.url).search}`);
    const error = c.req.query('error');

    if (pending.api === 'beneficiarios') {
      // Without a role in the beneficiary registry staff gives no token for it, and that is no failure.
      if (!error) {
        const tokens = await staff.exchange(callbackUrl, state, pending.codeVerifier).catch(refused('beneficiarios'));
        if (tokens) {
          session.grants.beneficiarios = tokens.grant;
        }
      }
      return c.redirect(pending.returnUrl, 302);
    }

    const returnTo = new URLSearchParams({ returnUrl: pending.returnUrl });
    if (error) {
      console.error(`Staff refused the sgt login: ${error} ${c.req.query('error_description') ?? ''}`);
      const signedOut = pending.silent && INTERACTION_REQUIRED.has(error);
      return c.redirect(signedOut ? `/welcome?${returnTo}&signedOut` : `/sign-in-failed?${returnTo}`, 302);
    }

    const tokens = await staff.exchange(callbackUrl, state, pending.codeVerifier).catch(refused('sgt'));
    if (!tokens) {
      return c.redirect(`/sign-in-failed?${returnTo}`, 302);
    }

    // A new session for the logged-in person, so an id handed out before the login is worth nothing.
    sessions.end(session);
    const loggedInSession = sessions.open(config.sessionMaxMs);
    loggedInSession.grants.sgt = tokens.grant;
    loggedInSession.idToken = tokens.idToken;

    return authorize(c, loggedInSession, 'beneficiarios', pending.returnUrl, true, pending.uiLocales);
  });

  app.get('/bff/me', async (c) => {
    const session = await loggedIn(c);
    if (!session) {
      return unauthenticated(c);
    }
    const grant = session.grants.sgt!;

    return c.json({
      idToken: session.idToken ? claimsOf(session.idToken) : {},
      accessToken: claimsOf(grant.accessToken),
    });
  });

  app.post('/bff/logout', async (c) => {
    const form = await c.req.parseBody();
    const session = sessionOf(c);
    if (session && form[CSRF_FIELD] !== session.csrfToken) {
      return c.json({ code: 'forbidden' }, 403);
    }
    const idToken = session?.idToken ?? null;
    if (session) {
      sessions.end(session);
    }
    forget(c);

    // An expired ID token is refused as a hint, so staff is asked to confirm with the person instead.
    const hint = idToken && Number(claimsOf(idToken)['exp']) * 1000 > now() ? idToken : null;
    const uiLocales = typeof form['ui_locales'] === 'string' ? form['ui_locales'] : null;
    return c.redirect((await staff.logoutUrl(hint, uiLocales)).toString(), 303);
  });

  for (const api of ['sgt', 'beneficiarios'] as const) {
    app.all(`/api/${api}/*`, async (c) => {
      const session = await loggedIn(c);
      if (!session) {
        return unauthenticated(c);
      }
      const changesSomething = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
      if (changesSomething && c.req.header(CSRF_HEADER) !== session.csrfToken) {
        return c.json({ code: 'forbidden' }, 403);
      }
      const grant = await grantFor(session, api);
      if (!grant) {
        return c.json({ code: 'forbidden' }, 403);
      }
      return forward(c, `${config[api].url}${pathAfter(c.req.url, `/api/${api}`)}`, grant.accessToken);
    });
  }

  return app;
}

/** Sends the request on to `target` with `accessToken`, and its answer back. */
async function forward(c: Context, target: string, accessToken: string): Promise<Response> {
  const headers = new Headers(c.req.raw.headers);
  HOP_HEADERS.forEach((name) => headers.delete(name));
  headers.set('authorization', `Bearer ${accessToken}`);
  const hasBody = !['GET', 'HEAD'].includes(c.req.method);

  const answer = await fetch(target, {
    method: c.req.method,
    headers,
    body: hasBody ? await c.req.arrayBuffer() : undefined,
    redirect: 'manual',
  });

  const answerHeaders = new Headers(answer.headers);
  // fetch already decoded the body, so the encoding and length the API sent no longer hold.
  ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].forEach((name) =>
    answerHeaders.delete(name),
  );
  return new Response(answer.body, { status: answer.status, headers: answerHeaders });
}

/** @returns the path and query after `prefix`, such as `/plots?x=1` from `/api/sgt/plots?x=1` */
function pathAfter(url: string, prefix: string): string {
  const { pathname, search } = new URL(url);
  return pathname.slice(prefix.length) + search;
}

/** @returns `url` when it is a path within the SPA, or its root, so a link cannot send the browser off it */
export function withinTheSpa(url: string | undefined): string {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') ? url : '/';
}

/** Logs why staff would not exchange a code for `api`'s token, and answers with no token. */
function refused(api: ApiName): (error: unknown) => null {
  return (error) => {
    console.error(`Staff refused the code for the ${api} token:`, error);
    return null;
  };
}
