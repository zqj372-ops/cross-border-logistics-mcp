import { describe, expect, it, vi } from "vitest";

import { schedulePollingTask } from "../../../apps/freightcom-quote/polling.mjs";

describe("Freightcom polling scheduler", () => {
  it("routes a scheduled asynchronous rejection to the failure handler", async () => {
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      scheduled = callback;
      return delayMs;
    });
    const failure = new Error("connection dropped");
    const task = vi.fn(() => Promise.reject(failure));
    const onFailure = vi.fn();

    schedulePollingTask({ schedule, delayMs: 1200, task, onFailure });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1200);

    scheduled?.();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(task).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(failure);
  });
});
