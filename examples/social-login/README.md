# NodeCG social login example

Log in with Discord (generic OAuth2, `makeOAuth2Provider` with a custom `identityFromUserinfo` mapping), or Twitch / Google (generic OIDC, `makeOidcProvider` via discovery).

## Provider setup

Register an app with each provider you want to use, with the matching redirect/callback URL:

| Provider | Create the app at                                 | Callback URL                                                | Env vars                                      |
| -------- | ------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| Discord  | https://discord.com/developers/applications       | `http://localhost:3000/api/authentication/callback/discord` | `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` |
| Twitch   | https://dev.twitch.tv/console/apps                | `http://localhost:3000/api/authentication/callback/twitch`  | `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`   |
| Google   | https://console.cloud.google.com/apis/credentials | `http://localhost:3000/api/authentication/callback/google`  | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`   |

Only providers with both env vars set are registered; the other buttons respond 404.

Twitch note: exposing `preferred_username` requires the OIDC `claims` request parameter, which `OidcProviderConfig` doesn't support yet — the display name falls back to the numeric user id.

## Run

```sh
DISCORD_CLIENT_ID=… DISCORD_CLIENT_SECRET=… pnpm start
```

Open http://localhost:3000/frontend/namespaces/social-login/

`pnpm start` serves the frontend through Vite in dev mode; for the built output run `pnpm build`, then start with `NODE_ENV=production`.
