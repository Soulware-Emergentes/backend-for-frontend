/** What the BFF reads from its environment. Every value is required unless it says otherwise. */
export interface Config {
  /** The port it listens on. */
  port: number;
  /** Its address as browsers reach it, which staff redirects back to and returns to after a logout. */
  publicUrl: string;
  /** Staff's issuer, which discovery is read from. */
  issuer: string;
  /** The client this deployment is registered as in staff, and its secret. */
  clientId: string;
  clientSecret: string;
  /** Each API it calls: where it is, and the scope its token is asked for under. */
  sgt: Api;
  beneficiarios: Api;
  /** How long a login lasts at most, counted from the moment the person logged in. */
  sessionMaxMs: number;
  /** Whether cookies are only sent over HTTPS. Off only in development, on plain http://localhost. */
  secureCookies: boolean;
  /** The built SPA to serve, when this deployment serves it; in development `ng serve` does. */
  staticDir: string | null;
}

export interface Api {
  url: string;
  scope: string;
}

export function configFrom(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new Error(`${name} is not set`);
    }
    return value;
  };

  return {
    port: Number(required('PORT')),
    publicUrl: required('BFF_PUBLIC_URL').replace(/\/$/, ''),
    issuer: required('STAFF_ISSUER'),
    clientId: required('BFF_CLIENT_ID'),
    clientSecret: required('BFF_CLIENT_SECRET'),
    sgt: { url: required('SGT_API').replace(/\/$/, ''), scope: required('SGT_SCOPE') },
    beneficiarios: {
      url: required('BENEFICIARIOS_API').replace(/\/$/, ''),
      scope: required('BENEFICIARIOS_SCOPE'),
    },
    sessionMaxMs: durationMs(required('SESSION_MAX')),
    secureCookies: required('SECURE_COOKIES') === 'true',
    staticDir: env['STATIC_DIR'] || null,
  };
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** Reads a duration the way staff writes them, such as `9h`, `3m` or `90s`. */
export function durationMs(value: string): number {
  const match = /^(\d+)([smh])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Not a duration: ${value}`);
  }
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}
