import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeeplinkRegistry } from "../registry";
import type { DeeplinkCallContext, DeeplinkHandler, DeeplinkRegisterOptions } from "../types";

/** Lets pending microtasks and 0 ms timers run (real timers in this file). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Records `<name>-in` / `<name>-out` around next(). */
function tracer(trace: string[], name: string): DeeplinkHandler {
  return async (_ctx, next) => {
    trace.push(`${name}-in`);
    const res = await next();
    trace.push(`${name}-out`);
    return res;
  };
}

const own = { owner: "test" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("single handler", () => {
  test("resolves with the result of an async handler", async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler("orders.open", async () => ({ opened: true }), own);
    await expect(reg.invoke("orders.open")).resolves.toEqual({ opened: true });
  });

  test("resolves with the return value of a sync handler", async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler("k", () => 42, own);
    await expect(reg.invoke("k")).resolves.toBe(42);
  });

  test("the handler sees params, input, the exact options object and a live signal", async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkCallContext | undefined;
    reg.registerHandler(
      "k",
      (ctx) => {
        seen = ctx;
        return "ok";
      },
      own,
    );
    const options = { timeout: 5000, tab: "items" };
    await reg.invoke("k", { id: 42 }, options);
    expect(seen?.key).toBe("k");
    expect(seen?.params).toEqual({ id: 42 });
    expect(seen?.input).toEqual({ id: 42 });
    expect(seen?.options).toBe(options);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal.aborted).toBe(false);
    expect(seen?.state).toEqual({});
    expect(seen?.step).toEqual({ index: 0, count: 1, owner: "test", global: false });
  });

  test("omitted params and options become undefined and {}", async () => {
    const reg = createDeeplinkRegistry();
    let seen: DeeplinkCallContext | undefined;
    reg.registerHandler(
      "k",
      (ctx) => {
        seen = ctx;
        return "ok";
      },
      own,
    );
    await reg.invoke("k");
    expect(seen?.params).toBeUndefined();
    expect(seen?.options).toEqual({});
  });
});

describe("waiting for a first handler", () => {
  test("a call made before any handler resolves once one is registered", async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke("k", { id: 1 });
    const handler = vi.fn((ctx: DeeplinkCallContext) => ctx.params);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    reg.registerHandler("k", handler, own);
    await expect(p).resolves.toEqual({ id: 1 });
  });

  test("several waiting calls each run, in arrival order", async () => {
    const reg = createDeeplinkRegistry();
    const order: unknown[] = [];
    const calls = [reg.invoke("k", { n: 1 }), reg.invoke("k", { n: 2 }), reg.invoke("k", { n: 3 })];
    reg.registerHandler(
      "k",
      (ctx) => {
        const n = (ctx.params as { n: number }).n;
        order.push(n);
        return n;
      },
      own,
    );
    await expect(Promise.all(calls)).resolves.toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a handler for another key does not start waiting calls", async () => {
    const reg = createDeeplinkRegistry();
    const pB = reg.invoke("b");
    const aHandler = vi.fn(() => "a");
    reg.registerHandler("a", aHandler, own);
    await flush();
    expect(aHandler).not.toHaveBeenCalled();
    reg.registerHandler("b", () => "b", own);
    await expect(pB).resolves.toBe("b");
  });
});

describe("chain order", () => {
  test("handlers run by ascending order regardless of registration order", async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerHandler("k", tracer(trace, "c"), { owner: "c", order: 30 });
    reg.registerHandler("k", tracer(trace, "a"), { owner: "a", order: 10 });
    reg.registerHandler("k", tracer(trace, "b"), { owner: "b", order: 20 });
    await reg.invoke("k");
    expect(trace).toEqual(["a-in", "b-in", "c-in", "c-out", "b-out", "a-out"]);
  });

  test("ties keep registration order; negative and fractional orders work", async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    reg.registerHandler("k", tracer(trace, "x"), { owner: "x" });
    reg.registerHandler("k", tracer(trace, "y"), { owner: "y", order: -1.5 });
    reg.registerHandler("k", tracer(trace, "z"), { owner: "z", order: 0 });
    await reg.invoke("k");
    expect(trace).toEqual(["y-in", "x-in", "z-in", "z-out", "x-out", "y-out"]);
  });

  test("a chain of transform handlers passes the payload through to the caller", async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler("k", (ctx, next) => next({ ...ctx, params: { ...(ctx.params as object), userId: "u1" } }), {
      owner: "auth",
      order: 10,
    });
    reg.registerHandler("k", async (_ctx, next) => ({ ...((await next()) as object), tracked: true }), {
      owner: "analytics",
      order: 20,
    });
    await expect(reg.invoke("k", { id: "42" })).resolves.toEqual({
      id: "42",
      userId: "u1",
      tracked: true,
    });
  });
});

describe("owner", () => {
  test("the same owner replaces its own handler and warns in dev", async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trace: string[] = [];
    reg.registerHandler("k", tracer(trace, "other"), { owner: "other", order: 5 });
    reg.registerHandler("k", tracer(trace, "old"), { owner: "orders", order: 1 });
    reg.registerHandler("k", tracer(trace, "new"), { owner: "orders", order: 10 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[daas-toolbox] deeplink "k" handler from owner "orders" replaced');
    await reg.invoke("k");
    expect(trace).toEqual(["other-in", "new-in", "new-out", "other-out"]);
  });

  test("registering repeatedly with one owner (a leaky side effect) leaves one handler", async () => {
    const reg = createDeeplinkRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn(() => "ok");
    for (let i = 0; i < 5; i += 1) reg.registerHandler("k", handler, { owner: "leaky" });
    await reg.invoke("k");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  test("a replaced handler's unregister is a no-op", async () => {
    const reg = createDeeplinkRegistry();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const unregisterOld = reg.registerHandler("k", () => "old", { owner: "orders" });
    reg.registerHandler("k", () => "new", { owner: "orders" });
    unregisterOld();
    expect(reg.has("k")).toBe(true);
    await expect(reg.invoke("k")).resolves.toBe("new");
  });

  test("the same function under two owners gives two handlers; unregister removes only its own", async () => {
    const reg = createDeeplinkRegistry();
    const fn = vi.fn((_ctx: DeeplinkCallContext, next: () => Promise<unknown>) => next());
    const unregister1 = reg.registerHandler("k", fn, { owner: "one" });
    reg.registerHandler("k", fn, { owner: "two" });
    await reg.invoke("k");
    expect(fn).toHaveBeenCalledTimes(2);
    unregister1();
    await reg.invoke("k");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("unregister", () => {
  test("after the last handler is unregistered, new calls wait again", async () => {
    const reg = createDeeplinkRegistry();
    const unregister = reg.registerHandler("k", () => "first", own);
    unregister();
    expect(reg.has("k")).toBe(false);
    const p = reg.invoke("k");
    reg.registerHandler("k", () => "second", own);
    await expect(p).resolves.toBe("second");
  });

  test("unregistering one handler keeps the others", async () => {
    const reg = createDeeplinkRegistry();
    const unregister = reg.registerHandler("k", (_ctx, next) => next(), { owner: "a", order: 1 });
    reg.registerHandler("k", () => "inner", { owner: "b", order: 2 });
    unregister();
    expect(reg.has("k")).toBe(true);
    await expect(reg.invoke("k")).resolves.toBe("inner");
  });

  test("calling unregister twice is a no-op", () => {
    const reg = createDeeplinkRegistry();
    const unregister = reg.registerHandler("k", () => 1, own);
    unregister();
    unregister();
    reg.registerHandler("k", () => 2, own);
    unregister();
    expect(reg.has("k")).toBe(true);
  });
});

describe("partial chain and batch flush", () => {
  test("with one handler present, a call runs at once with just that handler", async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler("k", (ctx, next) => next({ ...ctx, params: "auth-only" }), {
      owner: "auth",
    });
    await expect(reg.invoke("k", { id: 1 })).resolves.toBe("auth-only");
  });

  test("handlers registered in the same tick all join a waiting call", async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    const p = reg.invoke("k");
    reg.registerHandler("k", tracer(trace, "c"), { owner: "c", order: 3 });
    reg.registerHandler("k", tracer(trace, "a"), { owner: "a", order: 1 });
    reg.registerHandler("k", tracer(trace, "b"), { owner: "b", order: 2 });
    await p;
    expect(trace).toEqual(["a-in", "b-in", "c-in", "c-out", "b-out", "a-out"]);
  });

  test("a handler registered a macrotask later does not join the earlier call", async () => {
    const reg = createDeeplinkRegistry();
    const trace: string[] = [];
    const p = reg.invoke("k");
    reg.registerHandler("k", tracer(trace, "first"), { owner: "first" });
    await flush();
    reg.registerHandler("k", tracer(trace, "late"), { owner: "late" });
    await p;
    expect(trace).toEqual(["first-in", "first-out"]);
  });

  test("register then unregister in the same tick: the waiting call keeps waiting", async () => {
    const reg = createDeeplinkRegistry();
    const p = reg.invoke("k");
    let settled = false;
    p.then(() => {
      settled = true;
    });
    const unregister = reg.registerHandler("k", () => "gone", own);
    unregister();
    await flush();
    expect(settled).toBe(false);
    reg.registerHandler("k", () => "later", own);
    await expect(p).resolves.toBe("later");
  });

  test("all waiting calls aborted before the flush: the flush is a no-op", async () => {
    const reg = createDeeplinkRegistry();
    const controller = new AbortController();
    const p = reg.invoke("k", undefined, { signal: controller.signal });
    const handler = vi.fn(() => "ok");
    reg.registerHandler("k", handler, own);
    controller.abort(new Error("cancel"));
    await expect(p).rejects.toThrow("cancel");
    await flush();
    expect(handler).not.toHaveBeenCalled();
    await expect(reg.invoke("k")).resolves.toBe("ok");
  });
});

describe("snapshot", () => {
  test("a handler registered while a call runs does not join it", async () => {
    const reg = createDeeplinkRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    reg.registerHandler(
      "k",
      async (_ctx, next) => {
        trace.push("a");
        await gate;
        return next();
      },
      { owner: "a" },
    );
    const p = reg.invoke("k", { v: 1 });
    await flush();
    reg.registerHandler(
      "k",
      () => {
        trace.push("late");
        return "late";
      },
      { owner: "late" },
    );
    release();
    await expect(p).resolves.toEqual({ v: 1 });
    expect(trace).toEqual(["a"]);
  });

  test("a handler unregistered while a call runs still runs for that call", async () => {
    const reg = createDeeplinkRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reg.registerHandler(
      "k",
      async (_ctx, next) => {
        await gate;
        return next();
      },
      { owner: "outer", order: 1 },
    );
    const unregisterInner = reg.registerHandler("k", () => "inner", { owner: "inner", order: 2 });
    const p = reg.invoke("k");
    await flush();
    unregisterInner();
    release();
    await expect(p).resolves.toBe("inner");
  });
});

describe("calls are isolated", () => {
  test("concurrent calls get their own state", async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler(
      "k",
      async (ctx, next) => {
        ctx.state.mine = ctx.params;
        await flush();
        return next();
      },
      { owner: "a", order: 1 },
    );
    reg.registerHandler("k", (ctx) => ctx.state.mine, { owner: "b", order: 2 });
    await expect(Promise.all([reg.invoke("k", { n: 1 }), reg.invoke("k", { n: 2 })])).resolves.toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  test("a handler can invoke another key mid-chain", async () => {
    const reg = createDeeplinkRegistry();
    reg.registerHandler("inner.key", () => "inner", own);
    reg.registerHandler("outer.key", async () => `outer+${String(await reg.invoke("inner.key"))}`, own);
    await expect(reg.invoke("outer.key")).resolves.toBe("outer+inner");
  });
});

describe("errors and validation", () => {
  test("a sync throw becomes a rejection with the same error object", async () => {
    const reg = createDeeplinkRegistry();
    const boom = new Error("boom");
    reg.registerHandler(
      "k",
      () => {
        throw boom;
      },
      own,
    );
    await expect(reg.invoke("k")).rejects.toBe(boom);
  });

  test("one waiting call failing does not stop the other waiting calls", async () => {
    const reg = createDeeplinkRegistry();
    const p1 = reg.invoke("k", { fail: true });
    const p2 = reg.invoke("k", { fail: false });
    reg.registerHandler(
      "k",
      (ctx) => {
        if ((ctx.params as { fail: boolean }).fail) throw new Error("first");
        return "second";
      },
      own,
    );
    await expect(p1).rejects.toThrow("first");
    await expect(p2).resolves.toBe("second");
  });

  test("an empty key throws TypeError from registerHandler and invoke", () => {
    const reg = createDeeplinkRegistry();
    const msg = "[daas-toolbox] deeplink key must be a non-empty string, got an empty string";
    expect(() => reg.registerHandler("", () => 1, own)).toThrow(new TypeError(msg));
    expect(() => reg.invoke("")).toThrow(new TypeError(msg));
  });

  test.each([42, undefined, null])("a %s key throws TypeError naming its type", (key) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler(key as unknown as string, () => 1, own)).toThrow(TypeError);
    expect(() => reg.invoke(key as unknown as string)).toThrow(
      `deeplink key must be a non-empty string, got ${typeof key}`,
    );
  });

  test("a handler that is not a function throws TypeError", () => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler("k", "nope" as unknown as DeeplinkHandler, own)).toThrow(
      new TypeError("[daas-toolbox] deeplink handler must be a function"),
    );
  });

  test.each([Number.NaN, Infinity, "5"])("order %s throws TypeError", (order) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler("k", () => 1, { owner: "o", order: order as number })).toThrow(
      new TypeError(`[daas-toolbox] deeplink order must be a finite number, got ${String(order)}`),
    );
  });

  test.each(["", 42, undefined])("owner %s throws TypeError", (owner) => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler("k", () => 1, { owner: owner as string })).toThrow(
      new TypeError("[daas-toolbox] deeplink owner must be a non-empty string"),
    );
  });

  test("omitting options throws the owner TypeError", () => {
    const reg = createDeeplinkRegistry();
    expect(() => reg.registerHandler("k", () => 1, undefined as unknown as DeeplinkRegisterOptions)).toThrow(
      new TypeError("[daas-toolbox] deeplink owner must be a non-empty string"),
    );
  });
});

describe("has", () => {
  test("reflects whether at least one key handler is registered", () => {
    const reg = createDeeplinkRegistry();
    expect(reg.has("k")).toBe(false);
    const unregister = reg.registerHandler("k", () => 1, own);
    expect(reg.has("k")).toBe(true);
    unregister();
    expect(reg.has("k")).toBe(false);
  });
});
