import { ModuleRuntimeError } from "./errors";

type Disposer = () => void | Promise<void>;

export class RegistrationLease {
  private readonly disposers: Disposer[] = [];
  private closed = false;
  private closePromise: Promise<void> | null = null;

  add(disposer: Disposer): void {
    if (this.closed) {
      throw new ModuleRuntimeError("lease_closed", "Cannot register a disposer after the lease is closed.");
    }
    this.disposers.push(disposer);
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      while (this.disposers.length > 0) {
        const disposer = this.disposers.pop();
        if (disposer === undefined) continue;
        try {
          await disposer();
        } catch (error: unknown) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new ModuleRuntimeError(
          "lease_close_failed",
          "One or more module registrations could not be released.",
          { cause: new AggregateError(errors) },
        );
      }
    })();
    return this.closePromise;
  }

  closeSync(): void {
    if (this.closePromise !== null) return;
    this.closed = true;
    const errors: unknown[] = [];
    while (this.disposers.length > 0) {
      const disposer = this.disposers.pop();
      if (disposer === undefined) continue;
      try {
        const result = disposer();
        if (result instanceof Promise) {
          throw new ModuleRuntimeError("lease_async_disposer", "Synchronous module mounting cannot use an asynchronous disposer.");
        }
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    this.closePromise = Promise.resolve();
    if (errors.length > 0) {
      throw new ModuleRuntimeError(
        "lease_close_failed",
        "One or more module registrations could not be released.",
        { cause: new AggregateError(errors) },
      );
    }
  }
}
