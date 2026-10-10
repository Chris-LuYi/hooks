import { describe, expect, test } from "vitest";
import { DeeplinkTimeoutError, isDeeplinkTimeoutError } from "../errors";

describe("DeeplinkTimeoutError", () => {
  test("carries key, phase, timeout and a readable message for the waiting phase", () => {
    const err = new DeeplinkTimeoutError("orders.open", "waiting", 500);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeeplinkTimeoutError);
    expect(err.name).toBe("DeeplinkTimeoutError");
    expect(err.key).toBe("orders.open");
    expect(err.phase).toBe("waiting");
    expect(err.timeout).toBe(500);
    expect(err.message).toBe('[daas-toolbox] deeplink "orders.open" timed out after 500ms waiting for a handler');
  });

  test("has a distinct message for the running phase", () => {
    const err = new DeeplinkTimeoutError("orders.open", "running", 500);
    expect(err.message).toBe(
      '[daas-toolbox] deeplink "orders.open" timed out after 500ms while its handler was running',
    );
  });
});

describe("isDeeplinkTimeoutError", () => {
  test("recognises instances", () => {
    expect(isDeeplinkTimeoutError(new DeeplinkTimeoutError("k", "waiting", 1))).toBe(true);
  });

  test("recognises an error created by another copy of the module (flag, not instanceof)", () => {
    const foreign = Object.assign(new Error("x"), { __DAAS_DEEPLINK_TIMEOUT_ERROR__: true });
    expect(isDeeplinkTimeoutError(foreign)).toBe(true);
  });

  test.each([new Error("x"), null, undefined, "str", 42, {}])("rejects %s", (value) => {
    expect(isDeeplinkTimeoutError(value)).toBe(false);
  });
});
