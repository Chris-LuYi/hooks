import { useDeeplinkHandler } from '../../src';
import { pushTrail } from './contracts';
import { appDeeplinks } from './deeplinks';

export interface AnalyticsMfeProps {
  onTrack: (key: string) => void;
}

/**
 * Analytics MFE — an **enricher** (order 150): lets the call through, then tags the result on
 * the way out. Note `return`: forgetting it would hand `undefined` to the outer handlers.
 */
export function AnalyticsMfe({ onTrack }: AnalyticsMfeProps) {
  useDeeplinkHandler(
    appDeeplinks,
    'orders.open',
    async (ctx, next) => {
      pushTrail(ctx.state, 'analytics');
      const result = await next();
      onTrack(ctx.key);
      return { ...(result as object), tracked: true };
    },
    { owner: 'analytics', order: 150 },
  );
  return null;
}
