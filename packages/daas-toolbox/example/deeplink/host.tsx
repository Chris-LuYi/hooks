import { useEffect, useState } from 'react';
import { type DeeplinkInspection, deeplink } from '../../src';

export interface DeeplinkLogEntry {
  key: string;
  ok: boolean;
  ms: number;
  /** Owners of the key handlers that ran, in order. */
  trail: string[];
}

/**
 * Host boot code (no React needed): a global handler that wraps every deeplink, always outside
 * the MFEs' key handlers, so it also sees gate rejections and timeouts.
 * @returns `unregister`
 */
export function installDeeplinkLogger(log: (entry: DeeplinkLogEntry) => void): () => void {
  return deeplink.registerGlobalHandler(
    async (ctx, next) => {
      const start = Date.now();
      let ok = false;
      try {
        const result = await next();
        ok = true;
        return result;
      } finally {
        log({
          key: ctx.key,
          ok,
          ms: Date.now() - start,
          trail: [...((ctx.state.trail as string[] | undefined) ?? [])],
        });
      }
    },
    { owner: 'host-logger' },
  );
}

/** Host-side status panel: which MFEs registered what, in execution order. */
export function DeeplinkStatusPanel() {
  const [status, setStatus] = useState<DeeplinkInspection>(() => deeplink.inspect());

  useEffect(() => {
    setStatus(deeplink.inspect());
    return deeplink.subscribe(() => setStatus(deeplink.inspect()));
  }, []);

  return (
    <section aria-label="deeplink status">
      <p>global: {status.global.map((s) => s.owner).join(', ') || 'none'}</p>
      <ul>
        {status.keys.map((k) => (
          <li key={k.key}>
            {k.key}: {k.steps.map((s) => `${s.owner}(${s.order})`).join(' → ') || 'no handlers'}
            {k.waiting > 0 ? ` (${k.waiting} waiting)` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
