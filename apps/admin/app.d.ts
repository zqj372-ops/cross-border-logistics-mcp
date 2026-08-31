export function configActionAllowed(configState: unknown, ...actions: readonly string[]): boolean;
export function canApproveConfigChange(
  configState: unknown,
  preview: unknown,
  actorRef: unknown,
): boolean;
export function renderPluginConfigWorkspace(configState: unknown, options?: unknown): string;
