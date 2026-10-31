import { useDeeplinkHandler } from "../../src";
import { pushTrail } from "./contracts";
import { appDeeplinks } from "./deeplinks";

export class ForbiddenError extends Error {
  constructor() {
    super("Forbidden: missing role orders:view");
    this.name = "ForbiddenError";
  }
}

export interface AuthMfeProps {
  user: { name: string; roles: string[] };
}

/**
 * Auth MFE — a **gate**: outermost key handler (order 10). Rejects callers without the role,
 * otherwise adds `viewer` to the payload and continues with `next`.
 */
export function AuthMfe({ user }: AuthMfeProps) {
  useDeeplinkHandler(
    appDeeplinks,
    "orders.open",
    (ctx, next) => {
      pushTrail(ctx.state, "auth");
      if (!user.roles.includes("orders:view")) throw new ForbiddenError();
      return next({ ...ctx, params: { ...ctx.input, viewer: user.name } });
    },
    { owner: "auth", order: 10 },
  );
  return null;
}
