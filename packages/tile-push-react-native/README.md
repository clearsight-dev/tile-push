# @tile-push/react-native

Multi-tenant React Native OTA updates, powered by Tile Push.

## Install

```bash
npm install @tile-push/react-native @hot-updater/react-native
# or
yarn add @tile-push/react-native @hot-updater/react-native
```

> `@hot-updater/react-native` is a peer dependency — install it alongside.

## Usage

```tsx
import { TilePush } from '@tile-push/react-native';

function App() {
  return <YourAppRoot />;
}

export default TilePush.wrap({
  appId: 'tk_yourapp-prod',          // your Tile Push tenant id
  updateStrategy: 'fingerprint',     // or 'appVersion'
})(App);
```

That's the entire integration. Tile Push handles:

- Multi-tenant URL routing (`/api/check-update/v2/t/{appId}/...`)
- Cohort-based rollout picking on the client
- Update download + apply via the underlying SDK
- Sub-150ms latency from edge POPs (Firebase Hosting CDN)

## Configuration

```tsx
TilePush.wrap({
  // Required
  appId: 'tk_yourapp-prod',
  updateStrategy: 'fingerprint',

  // Optional — defaults to the production Tile Push API
  apiUrl: 'https://api.your-tile-push-deployment.example',

  // Pass through any standard HotUpdater wrap option
  fallbackComponent: MyFallback,
  reloadOnForceUpdate: true,
  requestHeaders: { 'x-client': 'myapp' },
  requestTimeout: 5000,
  onError: (err) => console.error('[Tile]', err),
  onProgress: (progress) => console.log(`download ${progress * 100}%`),
  onNotifyAppReady: (result) => console.log('app ready', result),
})(App);
```

## Alternative: Manual init

```tsx
import { TilePush } from '@tile-push/react-native';

// In your app entry, before any check is needed:
TilePush.init({
  appId: 'tk_yourapp-prod',
  updateStrategy: 'fingerprint',
});

// Later, anywhere:
const result = await TilePush.checkForUpdate({
  appId: 'tk_yourapp-prod',
  updateStrategy: 'fingerprint',
});
if (result) await result.updateBundle();
```

## Cohort targeting

Tile Push handles cohort picking transparently. Each device gets a stable
cohort value (1–1000) on first launch, persisted natively. When a bundle is
rolled out to a subset of cohorts, only devices in that set receive it. You
don't have to do anything — the SDK picks the right candidate from the
server's response.

For testing, you can override the device cohort:

```tsx
import { TilePush } from '@tile-push/react-native';

TilePush.setCohort('500');               // numeric cohort
TilePush.setCohort('beta-team');         // custom slug for explicit targeting
console.log(TilePush.getCohort());
```

## What's under the hood

This package is a thin wrapper around
[`@hot-updater/react-native`](https://www.npmjs.com/package/@hot-updater/react-native)
(MIT). The wrapper:

1. Provides a tenant-aware URL builder so customers don't have to construct
   `/api/check-update/v2/t/{appId}/...` themselves.
2. Adds client-side cohort picking against the v2 candidates response.
3. Re-exports upstream APIs with Tile Push branding so customers only import
   from `@tile-push/react-native`.

The native bridge, downloader, applier, store, and SDK hooks are upstream —
this package owns only the multi-tenant routing layer.

## License

MIT. See [LICENSE](./LICENSE) for full text including required upstream
attribution to the `@hot-updater/react-native` authors.
