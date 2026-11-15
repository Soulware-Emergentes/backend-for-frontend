# sgt-bff

The backend for sgt's web application. The browser logs in and calls the APIs through it, holding
nothing but a session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` outside development). The BFF is
the confidential client registered in staff: it keeps the person's tokens, one per API since staff
issues one per API, renews them while the login lasts, and sends each request on with the token its
API takes.

| Path | What it does |
| --- | --- |
| `GET /bff/login?returnUrl=&prompt=none&ui_locales=` | Logs in with staff, then silently gets the beneficiary registry's token, and goes on to `returnUrl`. A silent login staff cannot complete ends on `/welcome?signedOut`. |
| `GET /bff/callback` | Where staff redirects back to. |
| `GET /bff/me` | The claims of the person's ID and sgt access tokens. |
| `POST /bff/logout` | Ends the session here and in staff. |
| `/api/sgt/**`, `/api/beneficiarios/**` | Each API, with its token. |

Without a session, or once the login has lasted `SESSION_MAX`, the APIs and `/bff/me` answer `401`.
A request that changes something must echo the `XSRF-TOKEN` cookie in `X-XSRF-TOKEN`, which
Angular's `HttpClient` does by itself.

Sessions live in memory: one instance, and a restart asks everyone to log in again, silently for
whoever still has a session in staff.

## Running it

```bash
cp .env.example .env
bun install
bun run dev
```

In development the SPA runs on `ng serve` (port 4200), which proxies `/bff` and `/api` here, so the
cookie belongs to `localhost:4200`. Staff, sgt and the beneficiary registry run as usual (8082, 8080,
8081).

## Tests

```bash
bun test
bun run typecheck
```

## Deploying

The `Dockerfile` builds the web application from its repository (`WEB_REPOSITORY`, `WEB_REF`) and
serves it from the BFF, with `index.html` for the SPA's own routes. Set `BFF_PUBLIC_URL` to the
deployment's address and `SECURE_COOKIES=true`, and register `<BFF_PUBLIC_URL>/bff/callback` and
`<BFF_PUBLIC_URL>/` as the client's login and logout redirect URIs in staff.
