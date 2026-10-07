// Independent synthetic struct golden generator; no application implementation.
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
const floats=['0000000000000000','8000000000000000','3ff0000000000000','4340000000000001','3ee4f8b588e368f1','0000000000000001','7fefffffffffffff','3ff0000000000001'];
const states=['Pending','Starting','Running','Quarantined'];
const fixtures=[];
for(let i=0;i<16;i++){
const job={job_id:`job-${i}`,target_thread_id:'thread-한국어',channel_id:i%2?9223372036854775807n:9007199254740993n,owner_user_id:i%3?9007199254740995n:null,discord_message_id:i%4?9223372036854775806n:null,app_server_generation:i%2?9223372036854775807n:1n,execution_generation:i%3?1n:null,turn_observation_generation:i%4?-9223372036854775808n:null,goal_waiting:i%2===0,prompt:'quote " line\n control\t E000\uE000 astral\u{10000}',queued:i%2===1,ack_sent:i%3===0,state:states[i%4],attempt_count:BigInt(i),turn_id:i%2?'turn':null,baseline_turn_ids:['true','9007199254740993','{"2":1,"10":2}','한글'],last_error:i%2?'[cdr-rust:app-server-fork-quarantine:v1] held':'',created_at:0,updated_at:0};
fixtures.push({job,created_bits:floats[i%8],updated_bits:floats[(i+3)%8]});
}
const input=fixtures.map(serializeSerdeValue).join('\n')+'\n';
writeFileSync(new URL('input.ndjson',import.meta.url),input);
const binary=fileURLToPath(new URL('../.cargo-build/debug/migration-queue-job-serde-oracle.exe',import.meta.url));
const result=spawnSync(binary,[],{input,encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:2*1024*1024});
writeFileSync(new URL('stderr.log',import.meta.url),result.stderr??'');
if(result.error||result.status!==0)throw result.error??new Error(`Rust oracle status ${result.status}`);
writeFileSync(new URL('golden.ndjson',import.meta.url),result.stdout);
const rows=result.stdout.trim().split(/\r?\n/).map(JSON.parse);
if(rows.length!==16)throw new Error('Wrong golden count');
const report={rows:rows.length,exitCode:result.status,scope:'Exact declared Rust struct key order and synthetic f64 bits, bigint bounds, nulls and enum/string values'};
writeFileSync(new URL('golden-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));