import { useState } from "react";
import { useDeeplinkHandler } from "../../src";
import { type AuthorizedOrderParams, type OrderOpenResult, pushTrail } from "./contracts";
import { appDeeplinks } from "./deeplinks";

/**
 * Orders MFE — the **producer**: innermost (order 500). It opens the order and returns the
 * result without calling `next`. It reads `ctx.params` (what the gate passed on), not
 * `ctx.input` (the caller's original params).
 */
export function OrdersMfe() {
  const [opened, setOpened] = useState<AuthorizedOrderParams | null>(null);

  useDeeplinkHandler(
    appDeeplinks,
    "orders.open",
    async (ctx): Promise<OrderOpenResult> => {
      pushTrail(ctx.state, "orders");
      const params = ctx.params as AuthorizedOrderParams;
      // Real code would fetch here and pass ctx.signal so a timeout/abort cancels the request.
      setOpened(params);
      return { orderId: params.orderId, status: "opened", viewer: params.viewer };
    },
    { owner: "orders", order: 500 },
  );

  return opened ? (
    <aside aria-label="order drawer">
      Order {opened.orderId} opened for {opened.viewer}
    </aside>
  ) : null;
}
