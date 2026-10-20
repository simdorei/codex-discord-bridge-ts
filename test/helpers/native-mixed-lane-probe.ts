import {parentPort} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
const interval=25,anchor=performance.now();let sequence=0,stopped=false;
function tick(){if(stopped)return;sequence++;parentPort!.postMessage({sequence,target:anchor+sequence*interval,sent:performance.now()});schedule();}
function schedule(){setTimeout(tick,Math.max(0,anchor+(sequence+1)*interval-performance.now()));}
parentPort!.on('message',()=>{stopped=true;parentPort!.close();});schedule();
