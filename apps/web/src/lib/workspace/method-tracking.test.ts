import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const items = new Map<
    string,
    { key: string; value: Record<string, unknown> }
  >();
  const store = {
    putItem: vi.fn(
      async (
        namespace: string[],
        key: string,
        value: Record<string, unknown>
      ) => {
        items.set(`${namespace.join("/")}:${key}`, { key, value });
      }
    ),
    getItem: vi.fn(
      async (namespace: string[], key: string) =>
        items.get(`${namespace.join("/")}:${key}`) || null
    ),
    searchItems: vi.fn(async (namespace: string[]) => ({
      items: Array.from(items.entries())
        .filter(([fullKey]) => fullKey.startsWith(`${namespace.join("/")}:`))
        .map(([, item]) => item),
    })),
  };
  return {
    items,
    store,
    Client: vi.fn(function ClientMock() {
      return { store };
    }),
  };
});

vi.mock("@langchain/langgraph-sdk", () => ({ Client: harness.Client }));
vi.mock("@/constants", () => ({ LANGGRAPH_API_URL: "http://langgraph" }));

import {
  aggregateTrackingMetrics,
  appendTrackingEvents,
  readTrackingEvents,
} from "./method-tracking";

beforeEach(() => {
  harness.items.clear();
  harness.store.putItem.mockClear();
  harness.store.getItem.mockClear();
  harness.store.searchItems.mockClear();
});

describe("aggregateTrackingMetrics", () => {
  it("sums session summaries for a thread", () => {
    const metrics = aggregateTrackingMetrics("thread-1", [
      { type: "session_summary", keystrokes: 10, pasteEvents: 1 },
      { type: "session_summary", keystrokes: 5, pasteEvents: 2 },
      { type: "keystroke" },
    ]);
    expect(metrics).toMatchObject({
      threadId: "thread-1",
      sessionCount: 2,
      totalKeystrokes: 15,
      totalPasteEvents: 3,
    });
  });
});

describe("tracking event persistence", () => {
  it("keeps both appended batches", async () => {
    await appendTrackingEvents("thread-1", [{ type: "first" }]);
    await appendTrackingEvents("thread-1", [{ type: "second" }]);

    expect(harness.items.size).toBe(2);
  });

  it("reads batches in key order", async () => {
    await appendTrackingEvents("thread-1", [{ type: "first" }]);
    await appendTrackingEvents("thread-1", [{ type: "second" }]);

    const expected = Array.from(harness.items.values())
      .sort((left, right) => left.key.localeCompare(right.key))
      .flatMap((item) => item.value.events as unknown[]);
    expect(await readTrackingEvents("thread-1")).toEqual(expected);
  });

  it("does nothing for empty or invalid thread ids", async () => {
    await appendTrackingEvents("", [{ type: "ignored" }]);
    await appendTrackingEvents("../invalid", [{ type: "ignored" }]);

    await expect(readTrackingEvents("")).resolves.toEqual([]);
    await expect(readTrackingEvents("../invalid")).resolves.toEqual([]);
    expect(harness.store.putItem).not.toHaveBeenCalled();
    expect(harness.store.searchItems).not.toHaveBeenCalled();
  });
});
