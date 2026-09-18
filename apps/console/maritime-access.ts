export type ScheduleAccessPhase =
  | "anonymous"
  | "platform-no-org"
  | "select-org"
  | "no-membership"
  | "viewer"
  | "ready";

export interface ScheduleAccessState {
  readonly authenticated: boolean;
  readonly platform: boolean;
  readonly organizationId: string | null;
  readonly organizations: readonly {
    readonly organization_id: string;
    readonly display_name?: string;
    readonly status?: string;
  }[];
  readonly role: string | null;
  readonly canQuery: boolean;
  readonly phase: ScheduleAccessPhase;
}

export interface ScheduleAccessInput {
  readonly session?: {
    readonly authenticated?: boolean;
    readonly organization_id?: string | null;
    readonly identity?: {
      readonly user_id?: string;
      readonly platform_role?: string | null;
    } | null;
  } | null;
  readonly directory?: {
    readonly organizations?: readonly {
      readonly organization_id: string;
      readonly display_name?: string;
      readonly status?: string;
    }[];
    readonly memberships?: readonly {
      readonly organization_id: string;
      readonly user_id: string;
      readonly role?: string;
      readonly status?: string;
    }[];
  } | null;
}

const QUERY_ROLES = Object.freeze(["owner", "admin", "developer"]);

export function scheduleAccessState(input: ScheduleAccessInput = {}): ScheduleAccessState {
  const session = input.session;
  const directory = input.directory;
  const identity = session?.identity;
  const authenticated = session?.authenticated === true && Boolean(identity);
  const platform = Boolean(identity?.platform_role);
  const organizationId = session?.organization_id || null;
  const organizations = (directory?.organizations || []).filter((item) =>
    item.status === "active" &&
    (directory?.memberships || []).some((member) =>
      member.organization_id === item.organization_id &&
      member.user_id === identity?.user_id &&
      member.status === "active",
    ),
  );
  const membership = organizationId
    ? (directory?.memberships || []).find((member) =>
        member.organization_id === organizationId &&
        member.user_id === identity?.user_id &&
        member.status === "active",
      )
    : null;
  const role = membership?.role || null;
  const canQuery = authenticated && Boolean(organizationId) && QUERY_ROLES.includes(role ?? "");
  const phase: ScheduleAccessPhase = !authenticated
    ? "anonymous"
    : platform && !organizationId
      ? "platform-no-org"
      : !organizationId
        ? organizations.length ? "select-org" : "no-membership"
        : role === "viewer"
          ? "viewer"
          : canQuery ? "ready" : "no-membership";
  return Object.freeze({
    authenticated,
    platform,
    organizationId,
    organizations: Object.freeze(organizations.map((item) => Object.freeze(item))),
    role,
    canQuery,
    phase,
  });
}
