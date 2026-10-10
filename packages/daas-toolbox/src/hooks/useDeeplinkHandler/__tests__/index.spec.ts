import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAppDeeplinks, deeplink } from "../../../deeplink";
import useDeeplinkHandler from "../index";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDeeplinkHandler", () => {
  test("registers on mount and unregisters on unmount", async () => {
    const { unmount } = renderHook(() => useDeeplinkHandler("hook.mount", () => "ok", { owner: "m" }));
    expect(deeplink.has("hook.mount")).toBe(true);
    await expect(deeplink.invoke("hook.mount")).resolves.toBe("ok");
    unmount();
    expect(deeplink.has("hook.mount")).toBe(false);
  });

  test("uses the latest handler closure without re-registering", async () => {
    const register = vi.spyOn(deeplink, "registerHandler");
    const { rerender, unmount } = renderHook(
      ({ value }) => useDeeplinkHandler("hook.latest", () => value, { owner: "m" }),
      { initialProps: { value: 1 } },
    );
    rerender({ value: 2 });
    await expect(deeplink.invoke("hook.latest")).resolves.toBe(2);
    expect(register).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("two components chain on one key by order, not by mount order", async () => {
    const inner = renderHook(() =>
      useDeeplinkHandler("hook.chain", (ctx) => `inner(${String(ctx.params)})`, {
        owner: "inner",
        order: 2,
      }),
    );
    const outer = renderHook(() =>
      useDeeplinkHandler("hook.chain", async (ctx, next) => `${String(await next({ ...ctx, params: "b" }))}+outer`, {
        owner: "outer",
        order: 1,
      }),
    );
    await expect(deeplink.invoke("hook.chain")).resolves.toBe("inner(b)+outer");
    outer.unmount();
    inner.unmount();
  });

  test("re-registers when key, owner or order changes, not on re-render with equal options", () => {
    const register = vi.spyOn(deeplink, "registerHandler");
    const { rerender, unmount } = renderHook(
      ({ k, owner, order }) => useDeeplinkHandler(k, () => "x", { owner, order }),
      { initialProps: { k: "hook.re.a", owner: "o1", order: 1 } },
    );
    rerender({ k: "hook.re.a", owner: "o1", order: 1 });
    expect(register).toHaveBeenCalledTimes(1);
    rerender({ k: "hook.re.a", owner: "o1", order: 2 });
    expect(register).toHaveBeenCalledTimes(2);
    rerender({ k: "hook.re.a", owner: "o2", order: 2 });
    expect(register).toHaveBeenCalledTimes(3);
    rerender({ k: "hook.re.b", owner: "o2", order: 2 });
    expect(register).toHaveBeenCalledTimes(4);
    expect(deeplink.has("hook.re.a")).toBe(false);
    expect(deeplink.has("hook.re.b")).toBe(true);
    unmount();
    expect(deeplink.has("hook.re.b")).toBe(false);
  });

  test("the same owner in two components leaves one handler (the later one)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = renderHook(() => useDeeplinkHandler("hook.dup", () => "first", { owner: "dup" }));
    const second = renderHook(() => useDeeplinkHandler("hook.dup", () => "second", { owner: "dup" }));
    await expect(deeplink.invoke("hook.dup")).resolves.toBe("second");
    expect(warn).toHaveBeenCalledWith('[daas-toolbox] deeplink "hook.dup" handler from owner "dup" replaced');
    first.unmount();
    expect(deeplink.has("hook.dup")).toBe(true);
    second.unmount();
    expect(deeplink.has("hook.dup")).toBe(false);
  });

  test("StrictMode double-mount leaves exactly one live handler and no replace warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = renderHook(() => useDeeplinkHandler("hook.strict", () => "strict", { owner: "s" }), {
      wrapper: StrictMode,
    });
    expect(deeplink.has("hook.strict")).toBe(true);
    await expect(deeplink.invoke("hook.strict")).resolves.toBe("strict");
    expect(warn).not.toHaveBeenCalled();
    unmount();
    expect(deeplink.has("hook.strict")).toBe(false);
  });

  test("a call made before mount is delivered once the hook registers", async () => {
    const p = deeplink.invoke("hook.early", { id: 7 });
    const { unmount } = renderHook(() =>
      useDeeplinkHandler("hook.early", (ctx) => (ctx.params as { id: number }).id, {
        owner: "early",
      }),
    );
    await expect(p).resolves.toBe(7);
    unmount();
  });

  test("accepts a typed registry and infers ctx.input from its contract", async () => {
    interface HookDeeplinks {
      "hook.typed": { params: { n: number }; result: number };
    }
    const dl = createAppDeeplinks<HookDeeplinks>();
    const { unmount } = renderHook(() =>
      useDeeplinkHandler(dl, "hook.typed", (ctx) => ctx.input.n * 2, { owner: "typed", order: 3 }),
    );
    await expect(dl.invoke("hook.typed", { n: 21 })).resolves.toBe(42);
    unmount();
    expect(dl.has("hook.typed")).toBe(false);
  });
});
