import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  store: { putItem: vi.fn() },
  readAllStoreItems: vi.fn(),
}));

vi.mock("@langchain/langgraph-sdk", () => ({
  Client: vi.fn(function ClientMock() {
    return { store: harness.store };
  }),
}));
vi.mock("@/lib/admin/store-reader", () => ({
  readAllStoreItems: harness.readAllStoreItems,
}));
vi.mock("@/constants", () => ({ LANGGRAPH_API_URL: "http://langgraph" }));

import { appendProviderUsageEvent, listUsage } from "./usage-store";

describe("provider usage store", () => {
  beforeEach(() => {
    harness.store.putItem.mockReset().mockResolvedValue(undefined);
    harness.readAllStoreItems.mockReset();
  });

  it("appends one uniquely keyed event for every concurrent run", async () => {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        appendProviderUsageEvent("user-1", undefined, new Date("2026-08-15"))
      )
    );

    expect(harness.store.putItem).toHaveBeenCalledTimes(8);
    const keys = harness.store.putItem.mock.calls.map((call) => call[1]);
    expect(new Set(keys).size).toBe(8);
    expect(harness.store.putItem.mock.calls[0][0]).toEqual([
      "provider_usage",
      "user-1",
    ]);
    expect(harness.store.putItem.mock.calls[0][2]).toMatchObject({
      date: "2026-08-15",
      requests: 1,
    });
  });

  it("aggregates stored events on read", async () => {
    harness.readAllStoreItems.mockResolvedValue([
      { key: "event:1", value: { requests: 2, tokensIn: 10, tokensOut: 4 } },
      { key: "event:2", value: { requests: 1, tokensIn: 5, tokensOut: 2 } },
    ]);
    await expect(listUsage("user-1")).resolves.toEqual({
      requests: 3,
      tokensIn: 15,
      tokensOut: 6,
    });
  });

  it("stores best-effort integer token metadata and uses the UTC date", async () => {
    await appendProviderUsageEvent(
      "user-1",
      { tokensIn: 12, tokensOut: 7 },
      new Date("2026-08-15T23:59:59.999-04:00")
    );

    expect(harness.store.putItem).toHaveBeenCalledWith(
      ["provider_usage", "user-1"],
      expect.stringMatching(/^event:2026-08-16:/),
      { date: "2026-08-16", requests: 1, tokensIn: 12, tokensOut: 7 }
    );
  });
});
