import {requestObject,text,integer,enumeration,strings,required,defaulted,fields,length,count,validationError,jsonError} from './request-input.ts';
export type ComputerApp='chrome'|'notepad';
export type ComputerMouseButton='left'|'right'|'middle';
type Window={readonly window_id:bigint};
type Observed=Window&{readonly observation_id:string};
export type ComputerRequest=
 | Readonly<{kind:'computer_list_windows'|'computer_stop'}>
 | Readonly<{kind:'computer_launch';app:ComputerApp}>
 | Readonly<{kind:'computer_activate'|'computer_screenshot'}&Window>
 | Readonly<{kind:'computer_click';x:bigint;y:bigint;button:ComputerMouseButton;click_count:bigint}&Observed>
 | Readonly<{kind:'computer_drag';start_x:bigint;start_y:bigint;end_x:bigint;end_y:bigint}&Observed>
 | Readonly<{kind:'computer_scroll';x:bigint;y:bigint;delta_x:bigint;delta_y:bigint}&Observed>
 | Readonly<{kind:'computer_type_text'|'computer_set_clipboard';text:string}&Observed>
 | Readonly<{kind:'computer_press_keys';keys:readonly string[]}&Observed>
 | Readonly<{kind:'computer_close'}&Observed>;
const u64=integer(0n,18_446_744_073_709_551_615n),u32=integer(0n,4_294_967_295n),u8=integer(0n,255n),i32=integer(-2_147_483_648n,2_147_483_647n);
const app=enumeration(['chrome','notepad'] as const),button=enumeration(['left','right','middle'] as const);
/** Internal: input must be a freshly parsed, owned JSON object. */
export function decodeComputerRequestObject(v:Record<string,unknown>):ComputerRequest {
 const kind=required(v,'kind',text);
 const observed=()=>({window_id:required(v,'window_id',u64),observation_id:required(v,'observation_id',text)});
 switch(kind){
  case 'computer_list_windows':case 'computer_stop':fields(v,[]);return Object.freeze({kind});
  case 'computer_launch':fields(v,['app']);return Object.freeze({kind,app:required(v,'app',app)});
  case 'computer_activate':case 'computer_screenshot':fields(v,['window_id']);return Object.freeze({kind,window_id:required(v,'window_id',u64)});
  case 'computer_click':fields(v,['window_id','observation_id','x','y','button','click_count']);return Object.freeze({kind,...observed(),x:required(v,'x',u32),y:required(v,'y',u32),button:defaulted(v,'button',button,'left'),click_count:defaulted(v,'click_count',u8,1n)});
  case 'computer_drag':fields(v,['window_id','observation_id','start_x','start_y','end_x','end_y']);return Object.freeze({kind,...observed(),start_x:required(v,'start_x',u32),start_y:required(v,'start_y',u32),end_x:required(v,'end_x',u32),end_y:required(v,'end_y',u32)});
  case 'computer_scroll':fields(v,['window_id','observation_id','x','y','delta_x','delta_y']);return Object.freeze({kind,...observed(),x:required(v,'x',u32),y:required(v,'y',u32),delta_x:defaulted(v,'delta_x',i32,0n),delta_y:defaulted(v,'delta_y',i32,0n)});
  case 'computer_type_text':case 'computer_set_clipboard':fields(v,['window_id','observation_id','text']);return Object.freeze({kind,...observed(),text:required(v,'text',text)});
  case 'computer_press_keys':fields(v,['window_id','observation_id','keys']);return Object.freeze({kind,...observed(),keys:required(v,'keys',strings)});
  case 'computer_close':fields(v,['window_id','observation_id']);return Object.freeze({kind,...observed()});
  default:return jsonError('unknown computer request kind');
 }
}
/** All twelve computer request shapes and their source validation. This only
 * returns frozen data; no UI access, session authority, or execution is granted. */
export function parseComputerRequest(raw:string,maxBytes:number):ComputerRequest {
 return validateComputerRequest(decodeComputerRequestObject(requestObject(raw,maxBytes)));
}
/** Internal semantic phase for an already decoded family DTO. */
export function validateComputerRequest(v:ComputerRequest):ComputerRequest {
 if('window_id' in v&&v.window_id===0n)validationError('window_id','must be positive');
 if('observation_id' in v)length('observation_id',v.observation_id,8,100);
 const coordinate=(field:string,value:bigint)=>{if(value>100_000n)validationError(field,'must not exceed 100000');};
 if(v.kind==='computer_click'||v.kind==='computer_scroll'){coordinate('x',v.x);coordinate('y',v.y);}
 if(v.kind==='computer_click'&&(v.click_count<1n||v.click_count>3n))validationError('click_count','must be between 1 and 3');
 if(v.kind==='computer_drag')for(const key of ['start_x','start_y','end_x','end_y'] as const)coordinate(key,v[key]);
 if(v.kind==='computer_scroll'){
  if(v.delta_x < -10_000n||v.delta_x>10_000n||v.delta_y < -10_000n||v.delta_y>10_000n)validationError('delta','must be between -10000 and 10000');
  if(v.delta_x===0n&&v.delta_y===0n)validationError('delta','A non-zero scroll amount is required.');
 }
 if(v.kind==='computer_type_text')length('text',v.text,1,4_096);
 if(v.kind==='computer_set_clipboard')length('text',v.text,0,100_000);
 if(v.kind==='computer_press_keys')count('keys',v.keys.length,1,4);
 return v;
}
