import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
if(process.argv.length!==3)throw new Error('Usage: node tools/test-installed-package.mjs package.tgz');
const tarball=await realpath(resolve(process.argv[2]));
if(!tarball.endsWith('.tgz'))throw new Error('Expected a packed npm tarball');
await mkdir(join(root,'.runtime'),{recursive:true});
const prefix=await mkdtemp(join(root,'.runtime/npm-installed-'));
const npm=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
execFileSync(process.execPath,[npm,'install','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund','--package-lock=false',tarball],{cwd:root,stdio:'inherit',windowsHide:true});
const pkg=join(prefix,'node_modules/codex-discord-bridge-ts'),entry=join(pkg,'bin/codex-discord-bridge.mjs');
execFileSync(process.execPath,[entry,'--version'],{cwd:prefix,stdio:'inherit',windowsHide:true});
execFileSync(process.execPath,[entry,'--help'],{cwd:prefix,stdio:'ignore',windowsHide:true});
const gateway=join(pkg,'bin/cdr-mcp-server.mjs');
execFileSync(process.execPath,[gateway,'--help'],{cwd:prefix,stdio:'ignore',windowsHide:true});
const gatewayEnv={...process.env};for(const key of Object.keys(gatewayEnv))if(key.startsWith('SIMDOREI_MCP_'))delete gatewayEnv[key];
Object.assign(gatewayEnv,{SIMDOREI_MCP_PUBLIC_BASE_URL:'https://gateway.invalid',SIMDOREI_MCP_OWNER_TOKEN:'INSTALL_OWNER_FIXTURE_'.repeat(3),SIMDOREI_MCP_DEVICE_ID:'fixture',SIMDOREI_MCP_DEVICE_TOKEN:'INSTALL_DEVICE_FIXTURE_'.repeat(3),SIMDOREI_MCP_BIND:'127.0.0.1:0'});
const gatewayCheck=execFileSync(process.execPath,[gateway,'--check-config'],{cwd:prefix,env:gatewayEnv,encoding:'utf8',windowsHide:true});
if(JSON.parse(gatewayCheck).configured_devices!==1||gatewayCheck.includes('INSTALL_'))throw new Error('Installed gateway configuration check failed');
process.stdout.write('Installed MCP server CLI PASS; configuration check starts no listener.\n');
if(process.platform==='win32'){
 const cwd=join(prefix,'cli-check');await mkdir(cwd);
 await writeFile(join(cwd,'.env'),'DISCORD_BOT_TOKEN=INSTALL_FIXTURE_NOT_A_TOKEN\nDISCORD_ALLOWED_CHANNEL_IDS=123\nDISCORD_SESSION_MIRROR=0\n');
 const env={...process.env};for(const key of Object.keys(env))if(/^(DISCORD_|CODEX_|REMOTE_)/.test(key))delete env[key];
 const ps=join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),quote=s=>"'"+s.replaceAll("'","''")+"'",cmd=join(prefix,'node_modules/.bin/codex-discord-bridge.cmd');
 for(const flag of ['--version','--help','--check-config']){
  const script='& '+quote(cmd)+' '+quote(flag)+'; exit $LASTEXITCODE';
  const r=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd,env,encoding:'utf8',windowsHide:true,timeout:15000});
  if(r.status!==0||JSON.stringify(r).includes('INSTALL_FIXTURE_NOT_A_TOKEN')||flag==='--check-config'&&!r.stdout.includes('123'))throw new Error('Installed npm shim/configuration check failed: '+flag);
  process.stdout.write('Installed npm shim PASS: '+flag+'\n');
 }
 const r=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(pkg,'scripts/Test-NativeWorkspace.ps1'),'-SkipUnitTests'],{cwd:pkg,env,encoding:'utf8',windowsHide:true,timeout:15000});
 if(r.status!==0||!r.stdout.includes('"package_assets_verified":true')||!r.stdout.includes('"test_sources_available":false'))throw new Error('Installed PowerShell asset smoke failed');
 process.stdout.write('Installed PowerShell asset smoke PASS; no build compiler required.\n');
}
// Consumer dependencies only: tests run the installed dist graph with source
// stripping disabled. Compile fixture code in the development checkout once.
const {output}=JSON.parse(execFileSync(process.execPath,['tools/build-test-profile.mjs'],{cwd:root,encoding:'utf8',windowsHide:true}).trim());
const names=['windows-install-defaults','windows-application','windows-resources','windows-configured-remote','windows-remote-conflicts','windows-supervisor','windows-admin','windows-admin-threads','windows-archive-delete','windows-project','windows-files','windows-handoff','windows-mirror-continuity','windows-review-gaps'].map(name=>'windows-runtime/'+name);
names.push('runtime/action-executor/archive-action','store/archive-fence-existing','runtime/discord-runtime/diagnostics','runtime/session-mirror/append-journal','runtime/session-mirror/parallel-mapping','runtime/session-mirror/two-target-backlog-measurement','runtime/discord-runtime/receipt-echo','runtime/attachment-proxy','runtime/stop-worker','pro/helper','pro/release-tools','pro/connector-script','cli/cutover','mcp-server/gateway','mcp-server/oauth-worker-deadline','mcp-server/broker');
const fixtureRoot=join(prefix,'fixtures');await mkdir(fixtureRoot);
const targets=[];
for(const name of names){
 const source=join(output,'test',name+'.test.js');let code=await readFile(source,'utf8');
 const targetModule=specifier=>{
  const original=resolve(dirname(source),specifier),within=relative(join(output,'src'),original);
  return pathToFileURL(!isAbsolute(within)&&!within.startsWith('..')?join(pkg,'dist/src',within):original).href;
 };
 code=code.replace(/from\s*(['"])(\.\.?\/[^'"]+)\1/g,(_,quote,specifier)=>'from '+JSON.stringify(targetModule(specifier)));
 code=code.replace(/new URL\((['"])(\.\.?\/[^'"]+)\1,\s*import\.meta\.url\)/g,(_,quote,specifier)=>'new URL('+JSON.stringify(targetModule(specifier))+')');
 code=code.replace(/import\s*\{\s*(WebSocketServer|WebSocket)\s*\}\s*from\s*['"]ws['"];?/g,(_,name)=>`import {createRequire} from 'node:module'; const {${name}}=createRequire(${JSON.stringify(pathToFileURL(join(pkg,'package.json')).href)})('ws');`);
 const target=join(fixtureRoot,name.replaceAll('/','-')+'.test.mjs');await writeFile(target,code);targets.push(target);
}
await writeFile(join(root,'.runtime/npm-installed-prefix.txt'),prefix+'\n');
const result=spawnSync(process.execPath,['--no-strip-types','--test','--test-concurrency=1',...targets],{cwd:pkg,env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--no-strip-types'].filter(Boolean).join(' ')},stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
