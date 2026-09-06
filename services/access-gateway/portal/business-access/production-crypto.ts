import { createLocalJWKSet,jwtVerify } from "jose";

import { FileJwtSigningProvider,FileSecretPepperProvider,type FileJwtSigningProviderOptions,type FileSecretPepperProviderOptions } from "../../production-crypto";
import type { JwksResponse,JwtClaims } from "../../contracts";
import { BUSINESS_TOKEN_AUDIENCE } from "./contracts";
import type { BusinessSecretProvider,BusinessTokenSigner,BusinessTokenVerifier } from "./service";

export interface ProductionBusinessAccessCryptoOptions{
  readonly issuer:string;
  readonly pepper:FileSecretPepperProviderOptions;
  readonly jwt:FileJwtSigningProviderOptions&Readonly<{clockSkewSeconds?:number}>;
}
export async function createProductionBusinessAccessCrypto(options:ProductionBusinessAccessCryptoOptions):Promise<Readonly<{secretProvider:BusinessSecretProvider;tokenSigner:BusinessTokenSigner;tokenVerifier:BusinessTokenVerifier;getJwks:()=>Promise<JwksResponse>}>>{
  if(!options.issuer.startsWith("https://"))throw new Error("business_token_configuration_invalid");
  const skew=options.jwt.clockSkewSeconds??30;if(!Number.isSafeInteger(skew)||skew<0||skew>300)throw new Error("business_token_configuration_invalid");
  const pepper=new FileSecretPepperProvider(options.pepper),jwt=new FileJwtSigningProvider(options.jwt),jwks=await jwt.getJwks(),local=createLocalJWKSet({keys:jwks.keys.map(key=>({...key}))});
  const secretProvider:BusinessSecretProvider={pepperVersion:pepper.pepperVersion,hash:(secret,salt)=>pepper.hashCredentialSecret({secret,salt,pepperVersion:pepper.pepperVersion}),verify:(secret,material)=>pepper.verifyCredentialSecret({secret,material:material===null?null:{salt:material.salt,expectedHash:material.hash,pepperVersion:material.pepperVersion}})};
  const tokenSigner:BusinessTokenSigner={sign:async claims=>(await jwt.sign(claims as unknown as JwtClaims)).token};
  const tokenVerifier:BusinessTokenVerifier={verify:async token=>(await jwtVerify(token,local,{algorithms:["RS256"],issuer:options.issuer,audience:BUSINESS_TOKEN_AUDIENCE,clockTolerance:skew})).payload};
  return Object.freeze({secretProvider,tokenSigner,tokenVerifier,getJwks:()=>jwt.getJwks()});
}
