export interface PollingTaskOptions {
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly delayMs: number;
  readonly task: () => unknown | Promise<unknown>;
  readonly onFailure: (error: unknown) => void;
}

export declare function schedulePollingTask(options: PollingTaskOptions): unknown;
