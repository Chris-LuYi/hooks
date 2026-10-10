/**
 * Shared deeplink contracts. In a real DaaS setup this lives in a contracts package that every
 * MFE imports **type-only** (`import type`), so there is no runtime coupling between MFEs.
 */
export interface AppDeeplinks {
  /** Open an order. The caller sends the id; the chain returns what was opened. */
  "orders.open": { params: { orderId: string }; result: OrderOpenResult };
}

export interface OrderOpenResult {
  orderId: string;
  status: "opened";
  /** Added by the auth MFE on the way in. */
  viewer: string;
  /** Added by the analytics MFE on the way out. */
  tracked?: boolean;
}

/** Payload after the auth handler has enriched the caller's params. */
export interface AuthorizedOrderParams {
  orderId: string;
  viewer: string;
}

/** Names of the handlers that ran, collected in `ctx.state.trail` (shared by all handlers). */
export function pushTrail(state: Record<string, unknown>, owner: string): void {
  const trail = (state.trail as string[] | undefined) ?? [];
  trail.push(owner);
  state.trail = trail;
}
