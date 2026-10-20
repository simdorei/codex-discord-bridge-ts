import {boolean,enumeration,integer,jsonError,length,nullable,requestObject,text,validationError} from './request-input.ts';
import {outputRecord as record,outputArray as array} from './output-input.ts';
const u64=integer(0n,18446744073709551615n),i64=integer(-9223372036854775808n,9223372036854775807n);
const window=record({window_id:u64,title:text,process_name:text,left:i64,top:i64,width:u64,height:u64,active:boolean});
type Window=ReturnType<typeof window>;
const schemas={
 computer_windows:record({windows:array(window)}),
 computer_screenshot:record({observation_id:text,window,media_type:enumeration(['image/png']),data_base64:text}),
 computer_action:record({action:enumeration(['activate','launch','click','drag','scroll','type_text','press_keys','close','set_clipboard']),window_id:nullable(u64),message:text}),
 computer_stop:record({stopped:boolean,message:text}),
} as const;
export type RemoteComputerOutput={[K in keyof typeof schemas]:Readonly<{kind:K}>&ReturnType<(typeof schemas)[K]>}[keyof typeof schemas];
/** Only fresh owned bounded JSON values are valid inputs to this internal decoder. */
export function decodeComputerOutputObject(input:Record<string,unknown>):RemoteComputerOutput{
 if(!Object.hasOwn(input,'kind'))return jsonError('missing kind');
 const kind=text(input.kind);if(!Object.hasOwn(schemas,kind))return jsonError('unknown computer output kind');
 const payload:Record<string,unknown>=Object.create(null);
 for(const key of Object.keys(input))if(key!=='kind')payload[key]=input[key];
 if(kind==='computer_screenshot'&&!Object.hasOwn(payload,'media_type'))payload.media_type='image/png';
 if(kind==='computer_action'&&!Object.hasOwn(payload,'window_id'))payload.window_id=null;
 if(kind==='computer_stop'&&!Object.hasOwn(payload,'stopped'))payload.stopped=true;
 return Object.freeze({kind,...schemas[kind as keyof typeof schemas](payload)}) as RemoteComputerOutput;
}
function validateWindow(value:Window):void{
 if(value.window_id===0n||value.width===0n||value.height===0n)validationError('window','window id and dimensions must be positive');
}
export function validateComputerOutput(value:RemoteComputerOutput):void{
 switch(value.kind){
  case 'computer_windows':for(const item of value.windows)validateWindow(item);break;
  case 'computer_screenshot':length('observation_id',value.observation_id,8,100);validateWindow(value.window);length('data_base64',value.data_base64,12,12000000);break;
  case 'computer_action':if(value.window_id===0n)validationError('window_id','must be positive');break;
  case 'computer_stop':if(!value.stopped)validationError('stopped','must be true');break;
 }
}
export function parseComputerOutput(raw:string,maxBytes:number):RemoteComputerOutput{
 const result=decodeComputerOutputObject(requestObject(raw,maxBytes));validateComputerOutput(result);return result;
}
