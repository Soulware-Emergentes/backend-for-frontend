import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, createApp } from './app';
import type { Config } from './config';
import { Sessions } from './sessions';
import type { AuthorizationRequest, IdentityProvider, Tokens } from './staff';

/** The requests the fake API got: where to, and with which token. */
const received: { url: string; authorization: string | null; cookie: string | null; body: string }[] = [];
const api = Bun.serve({
  port: 0,
  fetch: async (request) => {
    received.push({
      url: new URL(request.url).pathname + new URL(request.url).search,
      authorization: request.headers.get('authorization'),
      cookie: request.headers.get('cookie'),
      body: await request.text(),
    });
    return Response.json({ ok: true });
  },
});
afterAll(() => api.stop());

const HOUR = 3_600_000;
let clock = Date.parse('2026-11-15T12:00:00Z');
const now = () => clock;

function jwt(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.signature`;
}

const config: Config = {
  port: 0,
  publicUrl: 'http://localhost:4200',
  issuer: 'http://localhost:8082',
  clientId: 'sgt-bff-dev',
  clientSecret: 'secret',
  sgt: { url: `http://localhost:${api.port}/api/v1`, scope: 'openid profile sgt-api-dev' },
  beneficiarios: { url: `http://localhost:${api.port}/beneficiarios/api/v1`, scope: 'beneficiarios-api-dev' },
  sessionMaxMs: 9 * HOUR,
  secureCookies: false,
  staticDir: null,
};

/** Staff, answering each code with a token for the API it was asked for, and renewing while allowed. */
class FakeStaff implements IdentityProvider {
  requests: AuthorizationRequest[] = [];
  renewable = true;
  refreshed = 0;

  async authorizationUrl(request: AuthorizationRequest): Promise<URL> {
    this.requests.push(request);
    return new URL(`${config.issuer}/oauth2/authorize?state=${request.state}&scope=${encodeURIComponent(request.scope)}`);
  }

  async exchange(callbackUrl: URL): Promise<Tokens> {
    const api = callbackUrl.searchParams.get('code')!;
    return this.tokens(api);
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    if (!this.renewable) {
      throw new Error('invalid_grant');
    }
    this.refreshed++;
    return this.tokens(refreshToken.replace('-refresh', ''));
  }

  async logoutUrl(idTokenHint: string | null): Promise<URL> {
    const url = new URL(`${config.issuer}/connect/logout`);
    url.searchParams.set(idTokenHint ? 'id_token_hint' : 'client_id', idTokenHint ?? config.clientId);
    return url;
  }

  private tokens(api: string): Tokens {
    return {
      grant: { accessToken: `${api}-token`, refreshToken: `${api}-refresh`, expiresAt: clock + 5 * 60_000 },
      idToken: api === 'sgt' ? jwt({ sub: 'person', exp: (clock + 30 * 60_000) / 1000 }) : null,
    };
  }
}

let staff: FakeStaff;
let app: ReturnType<typeof createApp>;

/** A browser: keeps the cookies the BFF sets and sends them back. */
class Browser {
  cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await app.request(`http://localhost:4200${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';');
      const [name, value] = pair!.split('=');
      const expired = attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0');
      if (expired || !value) {
        this.cookies.delete(name!);
      } else {
        this.cookies.set(name!, value);
      }
    }
    return response;
  }

  /** Follows a login through staff, which answers each authorization request with `answers`. */
  async logIn(returnUrl = '/map', answers: Record<string, string> = {}): Promise<Response> {
    const start = await this.request(`/bff/login?returnUrl=${encodeURIComponent(returnUrl)}`);
    return this.answer(start, answers);
  }

  async answer(redirect: Response, answers: Record<string, string> = {}): Promise<Response> {
    let response = redirect;
    while (response.headers.get('location')?.startsWith(config.issuer)) {
      const authorize = new URL(response.headers.get('location')!);
      const api = authorize.searchParams.get('scope')!.includes('sgt-api-dev') ? 'sgt' : 'beneficiarios';
      const state = authorize.searchParams.get('state')!;
      const answer = answers[api] ? `error=${answers[api]}` : `code=${api}`;
      response = await this.request(`/bff/callback?${answer}&state=${state}`);
    }
    return response;
  }
}

beforeEach(() => {
  received.length = 0;
  staff = new FakeStaff();
  app = createApp({ config, staff, sessions: new Sessions(now), now });
});

describe('logging in', () => {
  test('gets a token for sgt, then silently one for the beneficiary registry, and goes where the person was headed', async () => {
    const browser = new Browser();

    const landing = await browser.logIn('/map');

    expect(landing.headers.get('location')).toBe('/map');
    expect(staff.requests.map(({ scope, silent }) => [scope, silent])).toEqual([
      ['openid profile sgt-api-dev', false],
      ['beneficiarios-api-dev', true],
    ]);
    const me = (await (await browser.request('/bff/me')).json()) as { idToken: { sub: string } };
    expect(me.idToken.sub).toBe('person');
  });

  test('gives the browser only a session cookie it cannot read, and the CSRF token it must echo', async () => {
    const browser = new Browser();
    const start = await browser.request('/bff/login');

    const cookies = start.headers.getSetCookie();
    expect(cookies.find((cookie) => cookie.startsWith(SESSION_COOKIE))).toContain('HttpOnly');
    expect(cookies.find((cookie) => cookie.startsWith(CSRF_COOKIE))).not.toContain('HttpOnly');
  });

  test('hands out a new session once the person logs in', async () => {
    const browser = new Browser();
    await browser.request('/bff/login');
    const before = browser.cookies.get(SESSION_COOKIE);

    await browser.answer(await browser.request('/bff/login'));

    expect(browser.cookies.get(SESSION_COOKIE)).not.toBe(before);
  });

  test('a silent login staff cannot complete without the person ends on the welcome page', async () => {
    const browser = new Browser();
    const start = await browser.request('/bff/login?returnUrl=%2Fmap&prompt=none');

    const landing = await browser.answer(start, { sgt: 'login_required' });

    expect(landing.headers.get('location')).toBe('/welcome?returnUrl=%2Fmap&signedOut');
  });

  test('a login staff refuses ends on the failure page', async () => {
    const landing = await new Browser().logIn('/map', { sgt: 'access_denied' });

    expect(landing.headers.get('location')).toBe('/sign-in-failed?returnUrl=%2Fmap');
  });

  test('without a role in the beneficiary registry the person still logs in, with no token for it', async () => {
    const browser = new Browser();
    await browser.logIn('/map', { beneficiarios: 'access_denied' });

    const lookup = await browser.request('/api/beneficiarios/beneficiaries/lookup', {
      method: 'POST',
      headers: { [CSRF_HEADER]: browser.cookies.get(CSRF_COOKIE)! },
    });

    expect(lookup.status).toBe(403);
    expect((await browser.request('/bff/me')).status).toBe(200);
  });

  test('a callback nobody asked for is a failed login', async () => {
    const landing = await new Browser().request('/bff/callback?code=sgt&state=forged');

    expect(landing.headers.get('location')).toBe('/sign-in-failed');
  });

  test('never returns anywhere outside the SPA', async () => {
    const landing = await new Browser().logIn('//elsewhere.example/');

    expect(landing.headers.get('location')).toBe('/');
  });
});

describe('calling the APIs', () => {
  test('sends each API the token staff issued for it, and none of the browser cookies', async () => {
    const browser = new Browser();
    await browser.logIn();

    await browser.request('/api/sgt/plots/within?bbox=1,2,3,4');
    await browser.request('/api/beneficiarios/beneficiaries/lookup', {
      method: 'POST',
      headers: { [CSRF_HEADER]: browser.cookies.get(CSRF_COOKIE)!, 'content-type': 'application/json' },
      body: '{"legalDocuments":[]}',
    });

    expect(received).toEqual([
      { url: '/api/v1/plots/within?bbox=1,2,3,4', authorization: 'Bearer sgt-token', cookie: null, body: '' },
      {
        url: '/beneficiarios/api/v1/beneficiaries/lookup',
        authorization: 'Bearer beneficiarios-token',
        cookie: null,
        body: '{"legalDocuments":[]}',
      },
    ]);
  });

  test('refuses a change that does not echo the CSRF token', async () => {
    const browser = new Browser();
    await browser.logIn();

    const response = await browser.request('/api/sgt/plots', { method: 'POST', body: '{}' });

    expect(response.status).toBe(403);
    expect(received).toEqual([]);
  });

  test('answers 401 without a session', async () => {
    expect((await new Browser().request('/api/sgt/plots')).status).toBe(401);
    expect((await new Browser().request('/bff/me')).status).toBe(401);
  });

  test('renews a token about to expire without the person noticing', async () => {
    const browser = new Browser();
    await browser.logIn();
    clock += 5 * 60_000;

    const response = await browser.request('/api/sgt/plots');

    expect(response.status).toBe(200);
    expect(staff.refreshed).toBe(1);
  });

  test('answers 401 once staff no longer renews the login, and forgets the session', async () => {
    const browser = new Browser();
    await browser.logIn();
    clock += 5 * 60_000;
    staff.renewable = false;

    expect((await browser.request('/api/sgt/plots')).status).toBe(401);
    staff.renewable = true;
    expect((await browser.request('/bff/me')).status).toBe(401);
  });

  test('answers 401 once the login has lasted its maximum', async () => {
    const browser = new Browser();
    await browser.logIn();
    clock += 9 * HOUR;

    expect((await browser.request('/api/sgt/plots')).status).toBe(401);
  });
});

describe('logging out', () => {
  test('ends the session here and sends the browser to staff with the ID token', async () => {
    const browser = new Browser();
    await browser.logIn();

    const logout = await browser.request('/bff/logout', {
      method: 'POST',
      body: new URLSearchParams({ _csrf: browser.cookies.get(CSRF_COOKIE)! }),
    });

    expect(logout.status).toBe(303);
    expect(new URL(logout.headers.get('location')!).searchParams.has('id_token_hint')).toBe(true);
    expect((await browser.request('/bff/me')).status).toBe(401);
  });

  test('names the application instead once the ID token has expired', async () => {
    const browser = new Browser();
    await browser.logIn();
    clock += 31 * 60_000;
    staff.renewable = false;

    const logout = await browser.request('/bff/logout', {
      method: 'POST',
      body: new URLSearchParams({ _csrf: browser.cookies.get(CSRF_COOKIE)! }),
    });

    expect(new URL(logout.headers.get('location')!).searchParams.get('client_id')).toBe('sgt-bff-dev');
  });

  test('refuses a logout another site sends', async () => {
    const browser = new Browser();
    await browser.logIn();

    const logout = await browser.request('/bff/logout', { method: 'POST', body: new URLSearchParams() });

    expect(logout.status).toBe(403);
    expect((await browser.request('/bff/me')).status).toBe(200);
  });
});
