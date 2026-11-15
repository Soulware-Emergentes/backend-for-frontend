import * as oidc from 'openid-client';
import type { Config } from './config';
import type { Grant } from './sessions';

/** What a code or a refresh token was exchanged for. */
export interface Tokens {
  grant: Grant;
  /** Only when the login asked for `openid`: sgt's does, the beneficiary registry's does not. */
  idToken: string | null;
}

/** An authorization request to send the browser to staff with. */
export interface AuthorizationRequest {
  scope: string;
  state: string;
  codeChallenge: string;
  silent: boolean;
  uiLocales: string | null;
}

/** Staff, as the BFF talks to it: as a confidential client, from the server. */
export interface IdentityProvider {
  authorizationUrl(request: AuthorizationRequest): Promise<URL>;
  /** @throws when staff refuses the code */
  exchange(callbackUrl: URL, state: string, codeVerifier: string): Promise<Tokens>;
  /** @throws when staff refuses the refresh token, as once the login has lasted its maximum */
  refresh(refreshToken: string): Promise<Tokens>;
  /** Where to send the browser to end the person's session in staff too. */
  logoutUrl(idTokenHint: string | null, uiLocales: string | null): Promise<URL>;
}

/**
 * Talks to staff as `config.clientId`. Staff's discovery document is read the first time it is needed
 * and kept, and read again after a failure, so the BFF starts whether or not staff is up yet.
 */
export function staffAt(config: Config): IdentityProvider {
  const issuer = new URL(config.issuer);
  let discovered: Promise<oidc.Configuration> | null = null;
  const server = (): Promise<oidc.Configuration> =>
    (discovered ??= oidc
      .discovery(
        issuer,
        config.clientId,
        undefined,
        oidc.ClientSecretBasic(config.clientSecret),
        issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        discovered = null;
        throw error;
      }));
  const redirectUri = `${config.publicUrl}/bff/callback`;

  return {
    authorizationUrl: async ({ scope, state, codeChallenge, silent, uiLocales }) =>
      oidc.buildAuthorizationUrl(await server(), {
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(silent ? { prompt: 'none' } : {}),
        ...(uiLocales ? { ui_locales: uiLocales } : {}),
      }),

    exchange: async (callbackUrl, state, codeVerifier) =>
      tokensOf(
        await oidc.authorizationCodeGrant(await server(), callbackUrl, {
          pkceCodeVerifier: codeVerifier,
          expectedState: state,
        }),
      ),

    refresh: async (refreshToken) => {
      const tokens = tokensOf(await oidc.refreshTokenGrant(await server(), refreshToken));
      // Staff reuses a refresh token rather than rotating it, and may leave it out of the answer.
      return { ...tokens, grant: { ...tokens.grant, refreshToken: tokens.grant.refreshToken ?? refreshToken } };
    },

    logoutUrl: async (idTokenHint, uiLocales) =>
      oidc.buildEndSessionUrl(await server(), {
        post_logout_redirect_uri: `${config.publicUrl}/`,
        // Without an ID token staff asks the person to confirm, knowing the application by its id.
        ...(idTokenHint ? { id_token_hint: idTokenHint } : { client_id: config.clientId }),
        ...(uiLocales ? { ui_locales: uiLocales } : {}),
      }),
  };
}

function tokensOf(response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers): Tokens {
  return {
    grant: {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? null,
      expiresAt: Date.now() + (response.expiresIn() ?? 0) * 1000,
    },
    idToken: response.id_token ?? null,
  };
}

/** @returns the claims of a JWT staff issued, unverified: the BFF got it from staff itself */
export function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1];
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>) : {};
}
