import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Trusted runtime-assembly capability.
 *
 * The full facade includes mutation and fatal controls and must stay private to
 * the Service assembly. Module handlers, adapters, and the public router must
 * receive narrower capabilities. AsyncLocalStorage detects only recursion that
 * preserves its execution context; a caller can sever that context with a
 * pre-created AsyncResource. The assembly must therefore also prevent adapters
 * from calling the public router and must not expose this full coordinator to
 * either adapters or handlers.
 */
export interface RuntimeMutationCoordinator {
  withMutation<T>(operation: () => Promise<T>): Promise<T>;
  withControlledDispatch<T>(operation: () => Promise<T>): Promise<T>;
  tripFatal(error: unknown): never;
  isFatal(): boolean;
}

export type RuntimeMutationCoordinatorErrorCode =
  | "invalid_operation"
  | "non_reentrant";

const COORDINATOR_ERROR_MESSAGES: Readonly<
  Record<RuntimeMutationCoordinatorErrorCode, string>
> = {
  invalid_operation: "The runtime mutation coordinator operation is invalid.",
  non_reentrant: "The runtime mutation coordinator is not re-entrant.",
};

export class RuntimeMutationCoordinatorError extends Error {
  readonly code: RuntimeMutationCoordinatorErrorCode;

  constructor(code: RuntimeMutationCoordinatorErrorCode) {
    super(COORDINATOR_ERROR_MESSAGES[code]);
    this.name = "RuntimeMutationCoordinatorError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RuntimeMutationFatalError extends Error {
  readonly code = "fatal" as const;

  constructor() {
    super("The runtime mutation coordinator is in a fatal state.");
    this.name = "RuntimeMutationFatalError";
    Object.defineProperty(this, "stack", {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
    Object.freeze(this);
  }
}

Object.freeze(RuntimeMutationFatalError.prototype);

type LockMode = "reader" | "writer";
type ReleaseLock = () => void;

interface OwnerToken {
  readonly mode: LockMode;
  active: boolean;
}

interface Waiter {
  readonly mode: LockMode;
  readonly resolve: (release: ReleaseLock) => void;
  readonly reject: (reason?: unknown) => void;
}

function createCoordinator(): RuntimeMutationCoordinator {
  const ownership = new AsyncLocalStorage<OwnerToken>();
  let activeReaders = 0;
  let activeWriter = false;
  let fatalError: RuntimeMutationFatalError | undefined;
  let waiters: Waiter[] = [];

  const releaseLock = (mode: LockMode): ReleaseLock => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === "writer") {
        activeWriter = false;
      } else {
        activeReaders -= 1;
      }
      drain();
    };
  };

  const grantReader = (): void => {
    const waiter = waiters.shift();
    if (waiter === undefined || waiter.mode !== "reader") return;
    activeReaders += 1;
    waiter.resolve(releaseLock("reader"));
  };

  const rejectWaiters = (error: RuntimeMutationFatalError): void => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter.reject(error);
    }
  };

  function drain(): void {
    if (fatalError !== undefined) {
      rejectWaiters(fatalError);
      return;
    }
    if (activeWriter) return;

    if (activeReaders > 0) {
      while (waiters[0]?.mode === "reader") {
        grantReader();
      }
      return;
    }

    const next = waiters[0];
    if (next === undefined) return;
    if (next.mode === "writer") {
      waiters.shift();
      activeWriter = true;
      next.resolve(releaseLock("writer"));
      return;
    }

    while (waiters[0]?.mode === "reader") {
      grantReader();
    }
  }

  const canAcquireImmediately = (mode: LockMode): boolean => {
    if (waiters.length !== 0 || activeWriter) return false;
    return mode === "reader" || activeReaders === 0;
  };

  const acquire = (mode: LockMode): Promise<ReleaseLock> => {
    if (fatalError !== undefined) return Promise.reject(fatalError);

    if (canAcquireImmediately(mode)) {
      if (mode === "reader") {
        activeReaders += 1;
      } else {
        activeWriter = true;
      }
      return Promise.resolve(releaseLock(mode));
    }

    return new Promise<ReleaseLock>((resolve, reject) => {
      waiters.push({ mode, reject, resolve });
      drain();
    });
  };

  function assertCanEnter(
    operation: unknown,
  ): asserts operation is () => Promise<unknown> {
    if (typeof operation !== "function") {
      throw new RuntimeMutationCoordinatorError("invalid_operation");
    }
    if (fatalError !== undefined) {
      throw fatalError;
    }
    if (ownership.getStore()?.active === true) {
      throw new RuntimeMutationCoordinatorError("non_reentrant");
    }
  }

  const readFatalError = (): RuntimeMutationFatalError | undefined =>
    fatalError;

  const withLock = async <T>(
    mode: LockMode,
    operation: () => Promise<T>,
  ): Promise<T> => {
    assertCanEnter(operation);
    const release = await acquire(mode);
    const ownerToken: OwnerToken = { active: true, mode };
    try {
      const fatalBeforeOperation = readFatalError();
      if (fatalBeforeOperation !== undefined) {
        throw fatalBeforeOperation;
      }
      try {
        const result = await ownership.run(ownerToken, operation);
        const fatalAfterOperation = readFatalError();
        if (fatalAfterOperation !== undefined) {
          throw fatalAfterOperation;
        }
        return result;
      } catch (error: unknown) {
        const fatalDuringOperation = readFatalError();
        if (fatalDuringOperation !== undefined) {
          throw fatalDuringOperation;
        }
        throw error;
      }
    } finally {
      ownerToken.active = false;
      release();
    }
  };

  const withMutation = <T>(operation: () => Promise<T>): Promise<T> =>
    withLock("writer", operation);

  const withControlledDispatch = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => withLock("reader", operation);

  const tripFatal = (error: unknown): never => {
    void error;
    if (fatalError === undefined) {
      fatalError = new RuntimeMutationFatalError();
      rejectWaiters(fatalError);
    }
    throw fatalError;
  };

  const isFatal = (): boolean => fatalError !== undefined;

  const facade = Object.create(null) as RuntimeMutationCoordinator;
  Object.defineProperties(facade, {
    withMutation: {
      configurable: false,
      enumerable: true,
      value: withMutation,
      writable: false,
    },
    withControlledDispatch: {
      configurable: false,
      enumerable: true,
      value: withControlledDispatch,
      writable: false,
    },
    tripFatal: {
      configurable: false,
      enumerable: true,
      value: tripFatal,
      writable: false,
    },
    isFatal: {
      configurable: false,
      enumerable: true,
      value: isFatal,
      writable: false,
    },
  });
  return Object.freeze(facade);
}

export function createRuntimeMutationCoordinator(): RuntimeMutationCoordinator {
  return createCoordinator();
}
