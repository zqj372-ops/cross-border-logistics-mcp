import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { providerReleasePayloadSchema, signedProviderReleaseSchema, verifyProviderRelease } from "./managed-provider";
function read(path:string,maximum:number,secret=false){if(!isAbsolute(path))throw new Error("release_path_invalid");const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum||stat.size<1||(stat.mode&0o022)!==0||secret&&(stat.mode&0o077)!==0)throw new Error("release_file_invalid");return readFileSync(path);}
export async function signProviderRelease(options:{payloadFile:string;privateKeyFile:string;keyId:string;allowedHosts:readonly string[];outputFile:string}){
  if(dirname(options.outputFile)!==dirname(options.payloadFile))throw new Error("release_artifacts_must_share_directory");
  const payload=providerReleasePayloadSchema.parse(JSON.parse(read(options.payloadFile,16384).toString("utf8")) as unknown),privateBytes=read(options.privateKeyFile,16384,true);
  try{
    const key=createPrivateKey(privateBytes);if(key.asymmetricKeyType!=="ed25519")throw new Error("release_key_invalid");
    const release=signedProviderReleaseSchema.parse({payload,alg:"Ed25519",key_id:options.keyId,signature:sign(null,Buffer.from(JSON.stringify(payload)),key).toString("base64url")});
    verifyProviderRelease({release,artifact:read(resolve(dirname(options.payloadFile),payload.artifact_file),256*1024),sbom:read(resolve(dirname(options.payloadFile),payload.sbom_file),2*1024*1024),trustedKeys:{[options.keyId]:createPublicKey(key).export({type:"spki",format:"pem"}).toString()},allowedHosts:options.allowedHosts});
    try{const previous=signedProviderReleaseSchema.parse(JSON.parse(read(options.outputFile,16384).toString("utf8")) as unknown);if(payload.revision<=previous.payload.revision)throw new Error("release_revision_must_advance");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const temporary=`${options.outputFile}.${randomUUID()}.tmp`,handle=await open(temporary,"wx",0o600);
    try{await handle.writeFile(`${JSON.stringify(release,null,2)}\n`);await handle.sync();await handle.close();await rename(temporary,options.outputFile);const folder=await open(dirname(options.outputFile),"r");try{await folder.sync();}finally{await folder.close();}}
    finally{await handle.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);}
    const result=signedProviderReleaseSchema.parse(JSON.parse(read(options.outputFile,16384).toString("utf8")) as unknown);if(JSON.stringify(result)!==JSON.stringify(release))throw new Error("release_write_readback_failed");
    return {revision:payload.revision,artifact_digest:payload.artifact_digest,source_commit:payload.source_commit};
  }finally{privateBytes.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2);if(args.length!==10||args[0]!=="--payload"||args[2]!=="--key-file"||args[4]!=="--key-id"||args[6]!=="--allowed-host"||args[8]!=="--output")throw new Error("Expected --payload /path/payload.json --key-file /path/key.pem --key-id ID --allowed-host HOST --output /path/release.json");
  void signProviderRelease({payloadFile:args[1]!,privateKeyFile:args[3]!,keyId:args[5]!,allowedHosts:args[7]!.split(","),outputFile:args[9]!}).then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(()=>{process.stderr.write("provider_release_signing_failed\n");process.exitCode=1;});
}
