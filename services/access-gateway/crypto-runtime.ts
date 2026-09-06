import { join, resolve } from "node:path";
import { createOciSdkGatewayCryptoProviders, ociCryptoConfigurationFromEnvironment } from "./oci-crypto";
import type { JwtSigningProvider, SecretPepperProvider } from "./ports";
import { FileJwtSigningProvider, FileSecretPepperProvider } from "./production-crypto";

type RuntimePepperProvider=SecretPepperProvider&Readonly<{pepperVersion:string;supportsPepperVersion(version:string):boolean}>;
export interface OpenGatewayCryptoResult{readonly backend:"file"|"oci-vault";readonly pepper:RuntimePepperProvider;readonly signer:JwtSigningProvider;close():Promise<void>}
export interface GatewaySecretPaths{readonly secretsDir:string;readonly jwtSigningKeyPath:string;readonly jwtKeyHistoryPath:string;readonly credentialPepperPath:string;readonly credentialPepperHistoryPath:string}
export function gatewaySecretPaths(applicationRoot:string):GatewaySecretPaths{const secretsDir=join(resolve(applicationRoot),".secrets");return Object.freeze({secretsDir,jwtSigningKeyPath:join(secretsDir,"jwt-signing-key.pem"),jwtKeyHistoryPath:join(secretsDir,"jwt-key-history.json"),credentialPepperPath:join(secretsDir,"credential-pepper.bin"),credentialPepperHistoryPath:join(secretsDir,"credential-pepper-history.json")});}
function configuredSetting(environment:NodeJS.ProcessEnv,name:string):boolean{const value=environment[name]?.trim();return value!==undefined&&value.length>0;}
export async function openGatewayCrypto(input:Readonly<{environment:NodeJS.ProcessEnv;applicationRoot:string;pepperVersion:string;requiredPepperVersions:readonly string[];keyRetentionSeconds:number;nowSeconds:()=>number}>):Promise<OpenGatewayCryptoResult>{
 const configuration=ociCryptoConfigurationFromEnvironment(input.environment);
 if(configuration.backend==="oci-vault"){
  if(["ACCESS_GATEWAY_JWT_PRIVATE_KEY_PATH","ACCESS_GATEWAY_JWT_KEY_HISTORY_PATH","ACCESS_GATEWAY_PEPPER_PATH","ACCESS_GATEWAY_PEPPER_HISTORY_PATH"].some(name=>configuredSetting(input.environment,name)))throw new Error("OCI Vault crypto cannot be combined with file crypto overrides.");
  const providers=await createOciSdkGatewayCryptoProviders({configuration,activePepperVersion:input.pepperVersion,requiredPepperVersions:input.requiredPepperVersions});
  return Object.freeze({backend:"oci-vault" as const,pepper:providers.pepper,signer:providers.signer,close:()=>providers.close()});
 }
 const secrets=gatewaySecretPaths(input.applicationRoot);
 const pepper=new FileSecretPepperProvider({pepperPath:input.environment.ACCESS_GATEWAY_PEPPER_PATH?.trim()||secrets.credentialPepperPath,pepperVersion:input.pepperVersion,historyPath:input.environment.ACCESS_GATEWAY_PEPPER_HISTORY_PATH?.trim()||secrets.credentialPepperHistoryPath});
 if(input.requiredPepperVersions.some(version=>!pepper.supportsPepperVersion(version)))throw new Error("Stored credential pepper material is unavailable.");
 const signer=new FileJwtSigningProvider({privateKeyPath:input.environment.ACCESS_GATEWAY_JWT_PRIVATE_KEY_PATH?.trim()||secrets.jwtSigningKeyPath,historyPath:input.environment.ACCESS_GATEWAY_JWT_KEY_HISTORY_PATH?.trim()||secrets.jwtKeyHistoryPath,nowSeconds:input.nowSeconds,retentionSeconds:input.keyRetentionSeconds});
 return Object.freeze({backend:"file" as const,pepper,signer,close:()=>Promise.resolve()});
}
