import { describe, expect, test } from "vitest";
import * as toolbox from "../index";

const exported = toolbox as Record<string, unknown>;

describe("@daas/toolbox barrel", () => {
  test.each([
    "useRequest",
    "useHistoryTravel",
    "useMount",
    "useWhyDidYouUpdate",
    "useDeeplinkHandler",
    "clearCache",
    "isCancelledError",
    "CancelledError",
    "createDeeplinkRegistry",
    "createAppDeeplinks",
    "DeeplinkTimeoutError",
    "isDeeplinkTimeoutError",
  ])("exports %s", (name) => {
    expect(typeof exported[name]).toBe("function");
  });

  test("exports the shared deeplink registry", () => {
    expect(exported.deeplink).toEqual({
      registerHandler: expect.any(Function),
      invoke: expect.any(Function),
      has: expect.any(Function),
      registerGlobalHandler: expect.any(Function),
      inspect: expect.any(Function),
      subscribe: expect.any(Function),
    });
  });
});
