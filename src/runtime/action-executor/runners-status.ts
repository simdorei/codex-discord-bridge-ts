import {NativeRunnerInspectionReader} from './runner-inspection-native.ts';
/** Existing-store display snapshot only. No migration, retry, or hold release. */
export async function runnersMessage(path:string,signal?:AbortSignal):Promise<string>{return new NativeRunnerInspectionReader(path).global(signal);}
