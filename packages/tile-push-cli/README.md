# @tile-push/cli

Tile Push CLI — multi-tenant OTA updates for React Native.

## Install

```bash
npm install --save-dev @tile-push/cli
```

## Quickstart

```bash
npx tile-push init        # configure tile-push.config.ts + credentials
npx tile-push deploy      # ship a bundle
npx tile-push whoami      # verify your tenant
npx tile-push doctor      # diagnose setup issues
```

## Commands

| Command | Description |
| --- | --- |
| `tile-push init` | Set up `tile-push.config.ts` + `~/.tile-push/credentials.json` |
| `tile-push deploy` | Build and ship a new bundle |
| `tile-push bundle list/show/disable/enable/update/delete/promote` | Manage bundles |
| `tile-push rollback <channel>` | Disable the most recent enabled bundle |
| `tile-push channel [set]` | Read/write the channel in native files |
| `tile-push fingerprint [create]` | Compute/snapshot the bundle fingerprint |
| `tile-push whoami` | Show the active tenant and token info |
| `tile-push console` | Open the web console for this tenant |
| `tile-push doctor` | Diagnose configuration issues |

## Environment

The CLI reads credentials in this order:

1. `TILE_PUSH_APP_ID` + `TILE_PUSH_TOKEN` env vars (preferred for CI)
2. `~/.tile-push/credentials.json` (created by `tile-push init`)

Override the API base URL with `TILE_PUSH_API_URL` (defaults to
`https://api.tile-push.app`).

## Acknowledgements

Built on top of [hot-updater](https://github.com/gronxb/hot-updater), MIT-licensed.
Tile Push wraps hot-updater with multi-tenant routing, auth, and a unified
deploy CLI. The underlying bundle pipeline, fingerprinting, and bundle
metadata model are all hot-updater's work — we just add the SaaS layer
on top.

## License

MIT. See `LICENSE`.
