import {BridgeBroker} from './broker.ts';
import {definitions,capabilityGroups,requiredScopes} from './tool-inventory.ts';
import {parseProjectOperation,projectRequestLifetimeSeconds} from '../remote-agent/project-request.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
export {definitions,requiredScopes};
const aliases:Record<string,string>={repo_diff_summary:'repo_diff',show_changes:'repo_diff',list_computer_windows:'computer_list_windows',activate_computer_window:'computer_activate',launch_computer_app:'computer_launch',screenshot_computer_window:'computer_screenshot',click_computer_window:'computer_click',drag_computer_window:'computer_drag',scroll_computer_window:'computer_scroll',type_computer_text:'computer_type_text',press_computer_keys:'computer_press_keys',close_computer_window:'computer_close',set_computer_clipboard:'computer_set_clipboard',stop_computer_control:'computer_stop'};
const string=(v:unknown)=>{if(typeof v!=='string')throw Error('Expected text argument');return v;};
function shape(input:Record<string,unknown>,allowed:readonly string[]){if(Object.keys(input).some(key=>!allowed.includes(key)))throw Error('Unexpected tool argument');}
export async function dispatchTool(broker:BridgeBroker,resource:string,session:string,subject:string,name:string,input:Record<string,unknown>,signal:AbortSignal):Promise<Record<string,unknown>>{
 if(!requiredScopes(name))throw Error('Unknown tool');
 const connector=()=>{if(resource!=='https://simdorei.duckdns.org/mcp'||input.connector_resource!==resource)throw Error("OAuth connector mismatch: select 'Simdorei Local Project Oauth' and retry.");};
 let output:unknown;
 switch(name){
  case 'capability_inventory':shape(input,[]);output={ready:true,protocol_version:10,expected_tool_count:definitions.length,registered_tool_count:definitions.length,missing_tools:[],unexpected_tools:[],manifest_duplicate_tools:[],groups:capabilityGroups};break;
  case 'list_devices':shape(input,[]);output={devices:broker.listDevices()};break;
  case 'select_project':shape(input,['project_scope','connector_resource']);connector();output=await broker.selectProject(session,subject,string(input.project_scope),signal);break;
  case 'select_device':shape(input,['device_id','working_directory','connector_resource']);connector();output=await broker.selectDevice(session,subject,string(input.device_id),string(input.working_directory),signal);break;
  case 'set_working_directory':shape(input,['working_directory']);output=await broker.setDirectory(session,subject,string(input.working_directory),signal);break;
  case 'device_info':shape(input,[]);output=broker.deviceInfo(session,subject);break;
  case 'project_info':shape(input,[]);output=await broker.command(session,subject,{type:'project_info'},'project_info_result',signal);break;
  case 'list_project_files':shape(input,['pattern','limit']);output=await broker.command(session,subject,{type:'list_files',pattern:input.pattern??'**/*',limit:input.limit??200n},'list_files_result',signal);break;
  case 'read_project_file':case 'file_read_slice':shape(input,['path','start_line','max_lines']);output=await broker.command(session,subject,{type:'read_file',path:string(input.path),start_line:input.start_line??1n,max_lines:input.max_lines??250n},'read_file_result',signal);break;
  case 'write_project_file':shape(input,['path','content','expected_sha256']);output=await broker.command(session,subject,{type:'write_file',path:string(input.path),content:string(input.content),expected_sha256:input.expected_sha256??null},'write_file_result',signal);break;
  default:{const operation={...input,kind:aliases[name]??name},parsed=parseProjectOperation(serializeSerdeValue(operation),12000000);output=await broker.command(session,subject,{type:'project_operation',operation},'project_operation_result',signal,Number(projectRequestLifetimeSeconds(parsed)));}
 }
 const image=output as {kind?:string;data_base64?:string;image?:{media_type:string}};if(name==='retrieve_image'&&image?.kind==='image_retrieve')return{content:[{type:'image',data:image.data_base64,mimeType:image.image?.media_type}]};
 return{content:[{type:'text',text:serializeSerdeValue(output)}],structuredContent:output,isError:false};
}
