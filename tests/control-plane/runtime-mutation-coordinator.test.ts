import { describe, expect, it } from "vitest";

import {
  createRuntimeMutationCoordinator,
  type RuntimeMutationCoordinator,
} from "../../src/logistics_mcp/control-plane/runtime-mutation-coordinator";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type SettledResult =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timeout" };

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs = 250,
): Promise<SettledResult> {
  return new Promise<SettledResult>((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve({ status: "fulfilled", value });
      },
      (reason: unknown) => {
        clearTimeout(timeout);
        resolve({ status: "rejected", reason });
      },
    );
  });
}

function expectReentrantRejection(result: SettledResult): void {
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.reason).toMatchObject({
      code: "non_reentrant",
    });
  }
}

describe("runtime mutation coordinator", () => {
  it("allows concurrent controlled readers", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    let activeReaders = 0;
    let maximumReaders = 0;
    const firstEntered = deferred();
    const releaseReaders = deferred();

    const first = coordinator.withControlledDispatch(async () => {
      activeReaders += 1;
      maximumReaders = Math.max(maximumReaders, activeReaders);
      firstEntered.resolve();
      await releaseReaders.promise;
      activeReaders -= 1;
      return "first";
    });

    await firstEntered.promise;
    const second = coordinator.withControlledDispatch(() => {
      activeReaders += 1;
      maximumReaders = Math.max(maximumReaders, activeReaders);
      activeReaders -= 1;
      return Promise.resolve("second");
    });

    await expect(second).resolves.toBe("second");
    expect(maximumReaders).toBe(2);

    releaseReaders.resolve();
    await expect(first).resolves.toBe("first");
  });

  it("keeps mutations exclusive from readers and other mutations", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const writerEntered = deferred();
    const releaseWriter = deferred();
    let readerEntered = false;
    let secondWriterEntered = false;

    const writer = coordinator.withMutation(async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
      return "writer";
    });

    await writerEntered.promise;
    const reader = coordinator.withControlledDispatch(() => {
      readerEntered = true;
      return Promise.resolve("reader");
    });
    const secondWriter = coordinator.withMutation(() => {
      secondWriterEntered = true;
      return Promise.resolve("second-writer");
    });

    await Promise.resolve();
    expect(readerEntered).toBe(false);
    expect(secondWriterEntered).toBe(false);

    releaseWriter.resolve();
    await expect(writer).resolves.toBe("writer");
    await expect(reader).resolves.toBe("reader");
    await expect(secondWriter).resolves.toBe("second-writer");
  });

  it("blocks readers behind a waiting writer and preserves writer FIFO", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const initialReaderEntered = deferred();
    const releaseInitialReader = deferred();
    const writerOneEntered = deferred();
    const releaseWriterOne = deferred();
    const writerTwoEntered = deferred();
    const releaseWriterTwo = deferred();
    const order: string[] = [];
    let laterReaderEntered = false;

    const initialReader = coordinator.withControlledDispatch(async () => {
      initialReaderEntered.resolve();
      await releaseInitialReader.promise;
    });
    await initialReaderEntered.promise;

    const writerOne = coordinator.withMutation(async () => {
      order.push("writer-one");
      writerOneEntered.resolve();
      await releaseWriterOne.promise;
    });
    const writerTwo = coordinator.withMutation(async () => {
      order.push("writer-two");
      writerTwoEntered.resolve();
      await releaseWriterTwo.promise;
    });
    const laterReader = coordinator.withControlledDispatch(() => {
      laterReaderEntered = true;
      order.push("later-reader");
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    expect(laterReaderEntered).toBe(false);

    releaseInitialReader.resolve();
    await writerOneEntered.promise;
    expect(order).toEqual(["writer-one"]);
    expect(laterReaderEntered).toBe(false);

    releaseWriterOne.resolve();
    await writerTwoEntered.promise;
    expect(order).toEqual(["writer-one", "writer-two"]);
    expect(laterReaderEntered).toBe(false);

    releaseWriterTwo.resolve();
    await expect(initialReader).resolves.toBeUndefined();
    await expect(writerOne).resolves.toBeUndefined();
    await expect(writerTwo).resolves.toBeUndefined();
    await expect(laterReader).resolves.toBeUndefined();
    expect(order).toEqual(["writer-one", "writer-two", "later-reader"]);
  });

  it("holds the lock until an operation settles and releases it after a throw", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const entered = deferred();
    const release = deferred();
    const operationError = new Error("operation failure");

    const failing = coordinator.withMutation(async () => {
      entered.resolve();
      await release.promise;
      throw operationError;
    });

    await entered.promise;
    const blockedReader = coordinator.withControlledDispatch(() =>
      Promise.resolve("reader"),
    );
    await Promise.resolve();
    release.resolve();

    await expect(failing).rejects.toBe(operationError);
    await expect(blockedReader).resolves.toBe("reader");
  });

  it.each([
    ["writer-to-writer", "writer", "writer"],
    ["reader-to-writer", "reader", "writer"],
    ["writer-to-reader", "writer", "reader"],
    ["reader-to-reader", "reader", "reader"],
  ] as const)(
    "rejects %s recursion before waiting, including across await",
    async (_label, outerMode, innerMode) => {
      const coordinator = createRuntimeMutationCoordinator();
      const promise =
        outerMode === "writer"
          ? coordinator.withMutation(async () => {
              await Promise.resolve();
              return innerMode === "writer"
                ? coordinator.withMutation(() => Promise.resolve("nested"))
                : coordinator.withControlledDispatch(() =>
                    Promise.resolve("nested"),
                  );
            })
          : coordinator.withControlledDispatch(async () => {
              await Promise.resolve();
              return innerMode === "writer"
                ? coordinator.withMutation(() => Promise.resolve("nested"))
                : coordinator.withControlledDispatch(() =>
                    Promise.resolve("nested"),
                  );
            });

      expectReentrantRejection(await settleWithin(promise));
      expect(coordinator.isFatal()).toBe(false);
      await expect(
        coordinator.withControlledDispatch(() => Promise.resolve("after-recursion")),
      ).resolves.toBe("after-recursion");
    },
  );

  it("latches a sanitized fatal error and rejects an active writer on release", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const entered = deferred();
    const release = deferred();
    const holder = coordinator.withMutation(async () => {
      entered.resolve();
      await release.promise;
      return "held";
    });

    await entered.promise;
    let firstFatal: unknown;
    try {
      coordinator.tripFatal(new Error("secret upstream stack and message"));
    } catch (error: unknown) {
      firstFatal = error;
    }

    expect(firstFatal).toBeInstanceOf(Error);
    expect(firstFatal).toMatchObject({
      code: "fatal",
      message: "The runtime mutation coordinator is in a fatal state.",
    });
    if (firstFatal instanceof Error) {
      expect(firstFatal.stack).toBeUndefined();
      expect(firstFatal.message).not.toContain("secret");
      expect("cause" in firstFatal).toBe(false);
    }
    expect(coordinator.isFatal()).toBe(true);

    let secondFatal: unknown;
    try {
      coordinator.tripFatal(new Error("a different secret"));
    } catch (error: unknown) {
      secondFatal = error;
    }
    expect(secondFatal).toBe(firstFatal);

    await expect(
      coordinator.withControlledDispatch(() => Promise.resolve("blocked")),
    ).rejects.toBe(firstFatal);
    await expect(coordinator.withMutation(() => Promise.resolve("blocked"))).rejects.toBe(
      firstFatal,
    );

    release.resolve();
    await expect(holder).rejects.toBe(firstFatal);
    expect(coordinator.isFatal()).toBe(true);
    await expect(
      coordinator.withControlledDispatch(() => Promise.resolve("still-blocked")),
    ).rejects.toBe(firstFatal);
  });

  it("rejects an active reader even when it swallows tripFatal and returns success", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const fatalCaught = deferred<unknown>();

    const reader = coordinator.withControlledDispatch(async () => {
      try {
        coordinator.tripFatal(new Error("private adapter detail"));
      } catch (error: unknown) {
        fatalCaught.resolve(error);
      }
      await Promise.resolve();
      return "must-not-escape";
    });

    const fatal = await fatalCaught.promise;
    await expect(reader).rejects.toBe(fatal);
    expect(fatal).toMatchObject({
      code: "fatal",
      message: "The runtime mutation coordinator is in a fatal state.",
    });
  });

  it("rejects queued work when the fatal latch trips", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const entered = deferred();
    const release = deferred();
    const holder = coordinator.withMutation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const queuedReader = coordinator.withControlledDispatch(() =>
      Promise.resolve("queued"),
    );
    const queuedWriter = coordinator.withMutation(() => Promise.resolve("queued"));
    let fatal: unknown;
    try {
      coordinator.tripFatal(new Error("must not leak"));
    } catch (error: unknown) {
      fatal = error;
    }

    await expect(queuedReader).rejects.toBe(fatal);
    await expect(queuedWriter).rejects.toBe(fatal);
    release.resolve();
    await expect(holder).rejects.toBe(fatal);
  });

  it("allows a detached child to acquire after its outer owner is released", async () => {
    const coordinator = createRuntimeMutationCoordinator();
    const runDetachedChild = deferred();
    let detachedChild!: Promise<string>;

    await coordinator.withMutation(async () => {
      detachedChild = (async () => {
        await runDetachedChild.promise;
        return coordinator.withControlledDispatch(() =>
          Promise.resolve("detached-child"),
        );
      })();
      await Promise.resolve();
    });

    runDetachedChild.resolve();
    await expect(detachedChild).resolves.toBe("detached-child");
  });

  it("returns an immutable, non-overridable facade", async () => {
    const coordinator: RuntimeMutationCoordinator =
      createRuntimeMutationCoordinator();

    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(Object.getPrototypeOf(coordinator)).toBeNull();
    for (const method of [
      "withMutation",
      "withControlledDispatch",
      "tripFatal",
      "isFatal",
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(coordinator, method);
      expect(descriptor).toMatchObject({
        configurable: false,
        enumerable: true,
        writable: false,
      });
    }

    const withMutationDescriptor = Object.getOwnPropertyDescriptor(
      coordinator,
      "withMutation",
    );
    const originalWithMutation = withMutationDescriptor?.value as unknown;
    expect(
      Reflect.set(
        coordinator as unknown as object,
        "withMutation",
        () => "bypass",
      ),
    ).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(coordinator, "withMutation")?.value,
    ).toBe(originalWithMutation);

    const detachedDispatch = coordinator.withControlledDispatch.bind(undefined);
    await expect(detachedDispatch(() => Promise.resolve("detached"))).resolves.toBe(
      "detached",
    );
  });
});
