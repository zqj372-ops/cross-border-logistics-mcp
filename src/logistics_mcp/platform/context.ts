import { z } from "zod";

export const ACTOR_ROLES = [
  "admin",
  "sales",
  "operator",
  "customs_reviewer",
  "finance",
  "viewer",
  "service",
] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

export class AuthenticationError extends Error {
  readonly code = "authentication_failed";

  constructor(message = "Authentication failed.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);

const authClaimsSchema = z
  .object({
    tenant_id: identifierSchema,
    actor_id: identifierSchema,
    actor_role: z.enum(ACTOR_ROLES),
    roles: z.array(z.enum(ACTOR_ROLES)).min(1).max(16),
    scopes: z.array(z.string().min(1).max(200)).max(128),
    client_id: identifierSchema,
    session_id: identifierSchema,
    expires_at: z.number().int().positive(),
  })
  .strict();

export type AuthClaims = z.infer<typeof authClaimsSchema>;

export interface ExecutionContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly role: ActorRole;
  readonly roles: readonly ActorRole[];
  readonly scopes: readonly string[];
  readonly clientId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}

function invalidClaims(): AuthenticationError {
  return new AuthenticationError("Verified authentication claims are invalid.");
}

/**
 * Authentication boundary. Business tool parameters are deliberately not an
 * input to this function; only validated token claims may create a context.
 */
export function parseExecutionContext(input: unknown): ExecutionContext {
  const parsed = authClaimsSchema.safeParse(input);

  if (!parsed.success) {
    throw invalidClaims();
  }

  const claims = parsed.data;
  if (!claims.roles.includes(claims.actor_role)) {
    throw invalidClaims();
  }
  if (new Set(claims.roles).size !== claims.roles.length) {
    throw invalidClaims();
  }
  if (new Set(claims.scopes).size !== claims.scopes.length) {
    throw invalidClaims();
  }
  if (claims.expires_at <= Math.floor(Date.now() / 1000)) {
    throw new AuthenticationError("Authentication token is expired.");
  }

  return {
    tenantId: claims.tenant_id,
    actorId: claims.actor_id,
    role: claims.actor_role,
    roles: [...claims.roles],
    scopes: [...claims.scopes],
    clientId: claims.client_id,
    sessionId: claims.session_id,
    expiresAt: claims.expires_at,
  };
}
