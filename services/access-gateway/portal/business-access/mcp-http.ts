import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { BUSINESS_MCP_TOOLS } from "../../../../src/logistics_mcp/platform/application-tools";
import { BusinessAccessError } from "./contracts";
import type { ApplicationMcpAccessService } from "./mcp";
import { assertBusinessMachineExecutionResult, assertMachineBoundary, readMachineAuth, readMachineBody, sendMachineResponse, validateBusinessMachineInput, type BusinessMachineHttpOptions } from "./http";

export function createApplicationMcpHttpHandler(options: BusinessMachineHttpOptions & {
  mcpAccess: Pick<ApplicationMcpAccessService,"exchange"|"verify">; runtimeSecret: string; providerHealth?:()=>Promise<boolean>;
}) {
  if (options.runtimeSecret.length < 32) throw new Error("mcp_provider_secret_invalid");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return { handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? "").split("?", 1)[0]!;
    const health=path==="/access/v2/application/mcp/provider/health";
    const exchange = path === "/access/v2/application/mcp/token/exchange";
    const authority = path === "/access/v2/application/mcp/token/authority";
    const operation = BUSINESS_MCP_TOOLS.find(tool => path === `/access/v2/application/mcp/tools/${tool}`);
    if (!health && !exchange && !authority && !operation) return false;
    void (async () => {
      try {
        assertMachineBoundary(req, options);
        if(health){
          if(req.method!=="GET"||req.url!==path||req.headers.authorization||req.headers.cookie)throw new BusinessAccessError("business_request_denied");
          const count=req.rawHeaders.filter((name,index)=>index%2===0&&name.toLowerCase()==="x-freightclaw-runtime-token").length,value=req.headers["x-freightclaw-runtime-token"];
          if(count!==1||typeof value!=="string"||!timingSafeEqual(digest(value),digest(options.runtimeSecret)))throw new BusinessAccessError("business_provider_authentication_failed");
          if(!await options.providerHealth?.())throw new BusinessAccessError("business_provider_unavailable");
          sendMachineResponse(res,200,{schema_version:"business-provider-health@2026-09-06.v1",ready:true,contract_version:"business-mcp-result@2026-09-06.v1",operations:BUSINESS_MCP_TOOLS});return;
        }
        if (req.method !== "POST" || req.url !== path) throw new BusinessAccessError("business_request_denied");
        const credential = readMachineAuth(req, exchange ? "ApiKey" : "Bearer");
        const body = await readMachineBody(req, 32 * 1024);
        if (exchange) { sendMachineResponse(res, 200, await options.mcpAccess.exchange(credential, body, req.socket.remoteAddress ?? "unknown")); return; }
        if (authority) {
          z.object({ schema_version: z.literal("application-mcp-authority@2026-09-06.v1") }).strict().parse(body);
          await options.mcpAccess.verify(credential);
          sendMachineResponse(res, 200, { schema_version: "application-mcp-authority@2026-09-06.v1", status: "success", data: { active: true }, reason_codes: [] }); return;
        }
        const headerCount = req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "x-freightclaw-runtime-token").length;
        const runtimeSecret = req.headers["x-freightclaw-runtime-token"];
        if (headerCount !== 1 || typeof runtimeSecret !== "string" || !timingSafeEqual(digest(runtimeSecret), digest(options.runtimeSecret))) throw new BusinessAccessError("business_provider_authentication_failed");
        const call = z.object({ schema_version: z.literal("application-mcp-call@2026-09-06.v1"), request_id: z.string().regex(/^req_[A-Za-z0-9_-]{8,128}$/u), input: z.unknown() }).strict().parse(body);
        validateBusinessMachineInput(operation!, false, call.input);
        const machine = await options.mcpAccess.verify(credential, [operation!]);
        const result = await options.executor.execute({ operation: operation!, input: call.input, batch: false, requestId: call.request_id, machine });
        sendMachineResponse(res, 200, assertBusinessMachineExecutionResult(result, call.request_id, operation!));
      } catch (error) {
        const code = error instanceof BusinessAccessError ? error.code : error instanceof z.ZodError ? "business_body_invalid" : "business_unavailable";
        sendMachineResponse(res, code.includes("authentication") ? 401 : code.includes("body") ? 400 : code.includes("unavailable") ? 503 : 403,
          { schema_version: "application-mcp-access@2026-09-06.v1", status: code.includes("unavailable") ? "unavailable" : "blocked", data: null, reason_codes: [code] });
      }
    })();
    return true;
  } };
}
