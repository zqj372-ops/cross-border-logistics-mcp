import { startProductionPortal } from "./production";
const runtime=await startProductionPortal();let closing=false;const close=()=>{if(closing)return;closing=true;void runtime.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};process.once("SIGINT",close);process.once("SIGTERM",close);
