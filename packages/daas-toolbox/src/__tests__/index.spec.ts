import { describe, expect, test } from "vitest";
import * as toolbox from "../index";

const exported = toolbox as Record<string, unknown>;

describe("@daas-sdk/toolbox barrel", () => {
  test.each([
    "useRequest",
    "useHistoryTravel",
    "useMount",
    "useWhyDidYouUpdate",
    "usePrevious",
    "useCreation",
    "clearCache",
    "isCancelledError",
    "CancelledError",
  ])("exports %s", (name) => {
    expect(typeof exported[name]).toBe("function");
  });

  test("no longer exports the deeplink registry", () => {
    expect(exported.deeplink).toBeUndefined();
    expect(exported.useDeeplinkHandler).toBeUndefined();
  });
});
