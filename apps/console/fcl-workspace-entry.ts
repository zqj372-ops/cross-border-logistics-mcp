export interface FclWorkspaceSession {
  readonly authenticated?: boolean;
  readonly organization_id?: string | null;
  readonly fcl_capability?: {readonly fcl_personal?: boolean};
  readonly identity?: {readonly user_id?: string} | null;
}

interface PersonalWorkspaceResult {
  readonly organization_id: string | null;
}

interface EnterPersonalFclWorkspaceInput {
  readonly page: string;
  readonly session: FclWorkspaceSession | null | undefined;
  readonly prepareRequired?: boolean;
  readonly isCurrent: () => boolean;
  readonly switchToPersonal: () => Promise<PersonalWorkspaceResult>;
  readonly loadWorkspace: () => void | Promise<void>;
}

interface FclWorkspaceEntryControllerOptions {
  readonly getPage: () => string;
  readonly getSession: () => FclWorkspaceSession | null | undefined;
  readonly getUserId?: () => string | undefined;
  readonly switchToPersonal: (options: {readonly onSessionSelected: () => void}) => Promise<PersonalWorkspaceResult>;
  readonly completePreparation: () => Promise<PersonalWorkspaceResult>;
  readonly loadWorkspace: () => void | Promise<void>;
  readonly render: () => void;
}

export interface FclWorkspaceEntryController {
  gateRequired(): boolean;
  errorCode(): string;
  begin(): void;
  retry(): Promise<void>;
  cancel(): Promise<void>;
}

export function requiresPersonalFclWorkspace(page: string, session: FclWorkspaceSession | null | undefined): boolean {
  return page === 'fcl' &&
    session?.authenticated === true &&
    session.fcl_capability?.fcl_personal === true &&
    Boolean(session.organization_id);
}

export function fclWorkspaceEntryGateRequired(
  page: string,
  session: FclWorkspaceSession | null | undefined,
  state: {readonly switching?: boolean; readonly failed?: boolean} = {},
): boolean {
  return session?.fcl_capability?.fcl_personal === true &&
    page === 'fcl' &&
    (state.switching === true || state.failed === true || requiresPersonalFclWorkspace(page, session));
}

export async function enterPersonalFclWorkspace(input: EnterPersonalFclWorkspaceInput): Promise<'loaded' | 'stale'> {
  if (input.prepareRequired !== true && !requiresPersonalFclWorkspace(input.page, input.session)) {
    await input.loadWorkspace();
    return 'loaded';
  }
  const switched = await input.switchToPersonal();
  if (!input.isCurrent()) return 'stale';
  if (switched.organization_id !== null) {
    throw Object.assign(new Error('fcl_personal_workspace_switch_failed'), {
      code: 'fcl_personal_workspace_switch_failed',
    });
  }
  await input.loadWorkspace();
  return 'loaded';
}

export function createFclWorkspaceEntryController(options: FclWorkspaceEntryControllerOptions): FclWorkspaceEntryController {
  let promise: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let error = '';
  let blocked = false;
  let sequence = 0;
  let needsPreparation = false;

  const gateRequired = () => fclWorkspaceEntryGateRequired(options.getPage(), options.getSession(), {
    switching: blocked || needsPreparation,
    failed: Boolean(error),
  });

  const begin = () => {
    if (blocked || error || promise) return;
    const session = options.getSession();
    if (!needsPreparation && !requiresPersonalFclWorkspace(options.getPage(), session)) return;
    const controller = new AbortController();
    const userId = options.getUserId?.() ?? session?.identity?.user_id;
    const token = ++sequence;
    abort = controller;
    blocked = true;
    promise = (async () => {
      try {
        const result = await enterPersonalFclWorkspace({
          page: options.getPage(),
          session,
          prepareRequired: needsPreparation,
          isCurrent: () => token === sequence && !controller.signal.aborted && options.getPage() === 'fcl' && (options.getUserId?.() ?? options.getSession()?.identity?.user_id) === userId,
          switchToPersonal: async () => {
            if (needsPreparation && options.getSession()?.organization_id === null) {
              const prepared = await options.completePreparation();
              needsPreparation = false;
              return prepared;
            }
            const switched = await options.switchToPersonal({onSessionSelected: () => { needsPreparation = true; }});
            needsPreparation = false;
            return switched;
          },
          loadWorkspace: options.loadWorkspace,
        });
        if (token !== sequence) return;
        promise = null;
        abort = null;
        blocked = false;
        error = '';
        if (result === 'loaded') options.render();
      } catch (caught) {
        if (token !== sequence) return;
        promise = null;
        abort = null;
        const code = (caught as {code?: string})?.code;
        if (controller.signal.aborted || code === 'request_aborted') {
          blocked = false;
          error = '';
          if (options.getPage() === 'fcl') options.render();
          return;
        }
        blocked = true;
        error = (caught as {code?: string})?.code || 'network';
        if (options.getPage() === 'fcl') options.render();
      }
    })();
  };

  const invalidate = async (clearPreparation: boolean) => {
    const pending = promise;
    sequence += 1;
    abort?.abort();
    abort = null;
    promise = null;
    blocked = false;
    error = '';
    if (clearPreparation) needsPreparation = false;
    await pending?.catch(() => {});
  };

  return {
    gateRequired,
    errorCode: () => error,
    begin,
    retry: async () => {
      await invalidate(false);
      options.render();
    },
    cancel: async () => {
      await invalidate(true);
    },
  };
}
