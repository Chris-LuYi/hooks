import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deeplink } from "../../../src";
import { App } from "../App";

const ada = { name: "Ada", roles: ["orders:view"] };
const guest = { name: "Guest", roles: [] };

const resultText = () => screen.getByLabelText("caller result").textContent;

async function clickOpen(expected: string) {
  fireEvent.click(screen.getByText("Open order 42"));
  await waitFor(() => expect(resultText()).toBe(expected));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("deeplink sample: host + auth, analytics, orders and caller MFEs", () => {
  test("the full chain runs auth → analytics → orders and returns the enriched result", async () => {
    const onLog = vi.fn();
    const onTrack = vi.fn();
    render(<App user={ada} onLog={onLog} onTrack={onTrack} />);

    await clickOpen('result: {"orderId":"42","status":"opened","viewer":"Ada","tracked":true}');
    expect(screen.getByLabelText("order drawer").textContent).toBe("Order 42 opened for Ada");
    expect(onTrack).toHaveBeenCalledWith("orders.open");
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "orders.open",
        ok: true,
        trail: ["auth", "analytics", "orders"],
      }),
    );
  });

  test("the host status panel shows every registration in execution order", () => {
    render(<App user={ada} />);
    expect(screen.getByLabelText("deeplink status").textContent).toContain(
      "orders.open: auth(10) → analytics(150) → orders(500)",
    );
    expect(screen.getByLabelText("deeplink status").textContent).toContain("global: host-logger");
  });

  test("the auth gate rejects a user without the role; the order is never opened", async () => {
    const onLog = vi.fn();
    render(<App user={guest} onLog={onLog} />);

    await clickOpen("error: Forbidden: missing role orders:view");
    expect(screen.queryByLabelText("order drawer")).toBeNull();
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ ok: false, trail: ["auth"] }));
  });

  test("a partial chain runs with what is mounted (no analytics → no tracked flag)", async () => {
    render(<App user={ada} mounted={{ auth: true, orders: true }} />);
    await clickOpen('result: {"orderId":"42","status":"opened","viewer":"Ada"}');
  });

  test("a call made before any handler is registered waits for the MFE to mount", async () => {
    const { rerender } = render(<App user={ada} mounted={{}} />);
    fireEvent.click(screen.getByText("Open order 42"));
    expect(resultText()).toBe("opening…");
    await waitFor(() => expect(screen.getByLabelText("deeplink status").textContent).toContain("1 waiting"));

    // The MFEs mount later (lazy-loaded remotes): the waiting call runs the full chain.
    await act(async () => {
      rerender(<App user={ada} />);
    });
    await waitFor(() =>
      expect(resultText()).toBe('result: {"orderId":"42","status":"opened","viewer":"Ada","tracked":true}'),
    );
  });

  test("when no MFE ever registers, the caller gets a clear timeout message", async () => {
    render(<App user={ada} mounted={{}} timeout={50} />);
    await clickOpen("error: no MFE handles orders.open yet");
  });

  test("unmounting the sample removes every registration", () => {
    const { unmount } = render(<App user={ada} />);
    expect(deeplink.has("orders.open")).toBe(true);
    unmount();
    expect(deeplink.has("orders.open")).toBe(false);
    expect(deeplink.inspect()).toEqual({ global: [], keys: [] });
  });
});
