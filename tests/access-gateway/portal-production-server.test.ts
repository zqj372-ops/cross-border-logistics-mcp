import {existsSync} from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PortalService } from "../../services/access-gateway/portal/service";
import { startPortalServer, type StartedPortalServer } from "../../services/access-gateway/portal/server";
import { ociCryptoConfigurationFromEnvironment } from "../../services/access-gateway/oci-crypto";
import {createProductionPortalIdentityProvider} from "../../services/access-gateway/portal/production-identity";
import {validateProductionPortalEnvironment} from "../../services/access-gateway/portal/production";

const running:StartedPortalServer[]=[];
afterEach(async()=>{for(const item of running.splice(0))await item.close();});

describe("portal production observability routes",()=>{
  it("requires the complete deployed OCI Vault identity instead of falling back to file crypto",()=>{
    expect(()=>ociCryptoConfigurationFromEnvironment({ACCESS_GATEWAY_CRYPTO_BACKEND:"oci-vault"})).toThrow("OCI crypto settings must be supplied together");
    expect(()=>ociCryptoConfigurationFromEnvironment({ACCESS_GATEWAY_OCI_REGION:"ca-toronto-1"})).toThrow("require ACCESS_GATEWAY_CRYPTO_BACKEND=oci-vault");
  });
  it("reports the identity dependency unavailable when discovery cannot be verified",async()=>{
    const identity=createProductionPortalIdentityProvider({issuer:"https://identity.example.test/application/o/portal/",clientId:"portal",clientSecret:"secret",callbackUrl:"https://portal.example.test/console/auth/callback",fetch:()=>Promise.reject(new Error("offline")),timeoutMs:100});
    await expect(identity.health()).resolves.toBe(false);
  });
  it("rejects ambiguous roles and non-IP trusted proxies before runtime stores open",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"portal-preflight-")),file=join(directory,"configured");await writeFile(file,"configured",{mode:0o600});
    const env:NodeJS.ProcessEnv={PORTAL_STATE_ROOT:join(directory,"state"),PORTAL_PUBLIC_ORIGIN:"https://portal.example.test",PORTAL_OIDC_OPERATOR_GROUP:"same",PORTAL_OIDC_REVIEWER_GROUP:"same",PORTAL_TRUSTED_PROXY_ADDRESSES:"proxy.example.test",PORTAL_OIDC_CLIENT_SECRET_FILE:file,PORTAL_BUSINESS_CONFIG_FILE:file,PORTAL_BUSINESS_PEPPER_FILE:file,PORTAL_BUSINESS_JWT_PRIVATE_KEY_FILE:file,ACCESS_GATEWAY_APPLICATION_ROOT:directory,ACCESS_GATEWAY_MANAGEMENT_TENANT_ID:"management",ACCESS_GATEWAY_INSTANCE_ID:"instance",ACCESS_GATEWAY_JWT_ISSUER:"https://issuer.example.test",ACCESS_GATEWAY_JWT_AUDIENCE:"mcp",ACCESS_GATEWAY_PEPPER_VERSION:"pepper-v1",PORTAL_T0_REST_AUDIENCE:"rest",PORTAL_RELEASE_ID:"release",PORTAL_BUILD_ID:"build",PORTAL_OIDC_ISSUER:"https://identity.example.test",PORTAL_OIDC_CLIENT_ID:"portal",PORTAL_BUSINESS_TOKEN_ISSUER:"https://portal.example.test",PORTAL_BUSINESS_PEPPER_VERSION:"business-v1",PORTAL_BUSINESS_JWT_KEY_HISTORY_FILE:file};
    expect(()=>validateProductionPortalEnvironment(env)).toThrow("role groups must be distinct");expect(existsSync(join(directory,"state"))).toBe(false);env.PORTAL_OIDC_REVIEWER_GROUP="reviewers";expect(()=>validateProductionPortalEnvironment(env)).toThrow("must contain IP addresses");expect(existsSync(join(directory,"state"))).toBe(false);await rm(directory,{recursive:true,force:true});
  });
  it("separates liveness from dependency readiness and publishes only public JWKS",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"portal-production-server-"));
    await writeFile(join(directory,"index.html"),"<!doctype html><title>Portal</title>");
    const service={getState:()=>{throw new Error("unused");}} as unknown as PortalService;
    const server=await startPortalServer({mode:"fixtures",service,port:0,staticDirectory:directory,
      runtimeStatus:{releaseId:"release-1",buildId:"sha256:abc",readiness:()=>Promise.resolve({ready:false,checks:{portal_database:true,session_database:true,business_access_database:true,identity:false,business_configuration:true}})},
      businessJwks:()=>Promise.resolve({keys:[{kty:"RSA",kid:"business-1",use:"sig",alg:"RS256",n:"public",e:"AQAB"}]})});
    running.push(server);
    const health=await fetch(`${server.origin}/console/healthz`);expect(health.status).toBe(200);expect(await health.json()).toMatchObject({status:"success",data:{release_id:"release-1"}});
    const ready=await fetch(`${server.origin}/console/readyz`);expect(ready.status).toBe(503);expect(await ready.json()).toMatchObject({status:"unavailable",data:{ready:false,checks:{identity:false}}});
    const jwks=await fetch(`${server.origin}/access/v2/business/jwks.json`);expect(jwks.status).toBe(200);expect(await jwks.json()).toEqual({keys:[{kty:"RSA",kid:"business-1",use:"sig",alg:"RS256",n:"public",e:"AQAB"}]});
    expect(health.headers.get("cache-control")).toBe("no-store");expect(health.headers.get("content-security-policy")).toContain("default-src 'self'");
    await rm(directory,{recursive:true,force:true});
  });
});
