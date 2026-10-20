import {gatewayConfig} from './config.ts';
import {startGateway} from './server.ts';
export async function runGatewayCli(args:readonly string[],env:NodeJS.ProcessEnv=process.env):Promise<void>{
 if(args.length===1&&['-h','--help'].includes(args[0]!)){process.stdout.write('cdr-mcp-server [--check-config]\nConfigure SIMDOREI_MCP_PUBLIC_BASE_URL, OWNER_TOKEN, DEVICE_CREDENTIALS_JSON, OAUTH_DATABASE_PATH and BIND using their SIMDOREI_MCP_ prefix.\n');return;}
 if(args.length>1||args.length===1&&args[0]!=='--check-config')throw Error('Usage: cdr-mcp-server [--check-config]');const config=gatewayConfig(env);
 if(args[0]==='--check-config'){process.stdout.write(JSON.stringify({valid:true,configured_devices:config.credentials.length,bind:config.host+':'+config.port})+'\n');return;}
 const gateway=await startGateway(config);process.stdout.write('mcp_gateway_listening\n');await new Promise<void>(resolve=>{const stop=()=>resolve();process.once('SIGINT',stop);process.once('SIGTERM',stop);gateway.server.once('close',stop);}).finally(()=>gateway.close());
}
