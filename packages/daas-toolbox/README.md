# @daas-sdk/toolbox

DaaS toolbox: pure TypeScript source, copied by hand into the SDK. Not published to npm.
No runtime dependencies besides `react` (≥16.8).

```
src/
  hooks/      vendored subset of ahooks 3.11.0 (MIT)
  utils/      shared helpers
```

## Hooks

| Hook | Notes |
| --- | --- |
| `useRequest` | All built-in plugins (auto-run, cache, debounce, throttle, polling, retry, loading delay, refresh on focus). Also exports `clearCache`, `CancelledError`, `isCancelledError`. |
| `useHistoryTravel` | |
| `useMount` | |
| `usePrevious` | Also exports the `ShouldUpdateFunc` type. |
| `useCreation` | |
| `useWhyDidYouUpdate` | |

Internal helpers (`useMemoizedFn`, `useLatest`, `useUpdate`, `useUnmount`, `useUpdateEffect`,
`createUpdateEffect`) are kept because the hooks above depend on them.

Differences from upstream ahooks: `lodash/debounce` and `lodash/throttle` are replaced by
`src/utils/debounce.ts`, and `src/utils/isDev.ts` no longer needs `@types/node`.

## Deeplink handlers moved

The cross-MFE deeplink handler registry and `useDeeplinkHandler` now live in
`@daas-sdk/deeplink` (the `daas-cli` repo, `packages/deeplink`; the React hook is under
`@daas-sdk/deeplink/react`). The API and the runtime registry key are unchanged. Import them from
there instead of from this toolbox. The guide, the runnable example and the original design
records moved with the package: see `packages/deeplink/docs/deeplink-guide.md`,
`packages/deeplink/example/` and `packages/deeplink/docs/{specs,plans}/` in the daas-cli repo.

## Copying into an SDK

Copy `src/` and `THIRD_PARTY_NOTICES.md`. The notices file is required by the MIT licenses of
ahooks and lodash: keep it next to the copied code and include it in the SDK's published package
or its combined third-party notices, because bundlers strip license comments.

You can skip `**/__tests__/` and `src/utils/testingHelpers.ts`. The target tsconfig
needs `strict`-compatible settings and the `DOM` lib.

## Checks

```bash
pnpm --filter @daas-sdk/toolbox tsc
pnpm --filter @daas-sdk/toolbox test
```
