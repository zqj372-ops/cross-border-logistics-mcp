export interface QuoteClient {
  submitRate(input: unknown): Promise<{ readonly requestId: string }>;
  pollRate(requestId: string): Promise<{
    readonly status: { readonly done: boolean; readonly total: number; readonly complete: number };
    readonly rates: readonly Record<string, unknown>[];
    readonly retrievedAt: string;
    readonly sourceRef: Record<string, unknown>;
  }>;
}

export function createQuoteApiHandler(options: {
  readonly client: QuoteClient;
  readonly tokenConfigured: boolean;
  readonly baseUrl: string;
  readonly requestHandles?: Map<string, number>;
}): (request: Request) => Promise<Response>;

export function createQuoteServer(options?: Record<string, unknown>): {
  readonly server: import("node:http").Server;
  readonly port: number;
  readonly host: string;
  readonly endpoint: string;
  readonly tokenConfigured: boolean;
};

export function startQuoteServer(options?: Record<string, unknown>): ReturnType<typeof createQuoteServer>;
