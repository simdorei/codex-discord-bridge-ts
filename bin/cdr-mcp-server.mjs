#!/usr/bin/env node
const [major,minor]=process.versions.node.split('.').map(Number);
try{
 if(major!==24||minor<21)throw Error('Node.js >=24.21.0 <25 is required');
 const {runGatewayCli}=await import('../dist/src/mcp-server/main.js');await runGatewayCli(process.argv.slice(2));
}catch(error){process.stderr.write('mcp_gateway_failed: '+(error instanceof Error?error.message:'startup failed')+'\n');process.exitCode=1;}
