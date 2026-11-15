/** The APIs a session holds a token for. */
export type ApiName = 'sgt' | 'beneficiarios';

/** An access token staff issued for one API, and how to renew it. */
export interface Grant {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working, in milliseconds since the epoch. */
  expiresAt: number;
}

/** An authorization request sent to staff and not answered yet. */
export interface PendingLogin {
  api: ApiName;
  codeVerifier: string;
  /** Where the person was headed, a path within the SPA. */
  returnUrl: string;
  /** Whether staff was asked to show nothing (`prompt=none`). */
  silent: boolean;
  /** The languages staff was asked to show its pages in, passed on to the next trip. */
  uiLocales: string | null;
  startedAt: number;
}

/**
 * A browser's session. Before the person logs in it holds only the authorization requests on their
 * way to staff; once they have, the tokens for each API and the ID token, until {@link expiresAt}.
 */
export interface Session {
  id: string;
  /** What a request that changes something must echo back, so another site cannot send one. */
  csrfToken: string;
  /** When the login ends, whatever renewing says, in milliseconds since the epoch. */
  expiresAt: number;
  grants: Partial<Record<ApiName, Grant>>;
  idToken: string | null;
  pending: Map<string, PendingLogin>;
}

/** How long staff may take to answer an authorization request. */
export const PENDING_LOGIN_MS = 10 * 60_000;

/**
 * The sessions of this one instance, in memory. A restart ends them all, which only asks everyone to
 * log in again, silently for whoever still has a session in staff.
 */
export class Sessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly now: () => number = Date.now) {}

  /** @returns the live session the cookie names, forgetting it if it has ended */
  find(id: string | undefined): Session | null {
    if (!id) {
      return null;
    }
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  /** Opens a session lasting `lifetimeMs`; one waiting for a login lasts as long as staff may take. */
  open(lifetimeMs: number = PENDING_LOGIN_MS): Session {
    const session: Session = {
      id: randomToken(),
      csrfToken: randomToken(),
      expiresAt: this.now() + lifetimeMs,
      grants: {},
      idToken: null,
      pending: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  end(session: Session): void {
    this.sessions.delete(session.id);
  }

  /** Forgets the sessions that have ended and the authorization requests staff never answered. */
  sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        continue;
      }
      for (const [state, pending] of session.pending) {
        if (pending.startedAt + PENDING_LOGIN_MS <= now) {
          session.pending.delete(state);
        }
      }
    }
  }
}

export function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}
