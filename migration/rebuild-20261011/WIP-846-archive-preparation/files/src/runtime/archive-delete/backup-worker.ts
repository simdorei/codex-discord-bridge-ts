import {parentPort,workerData} from 'node:worker_threads';
import {createArchiveBackupInWorker,type ArchiveBackupWorkerInput} from './backup-core.ts';
if(parentPort===null)throw new Error('Archive backup requires native worker ownership');
parentPort.postMessage(await createArchiveBackupInWorker(workerData as ArchiveBackupWorkerInput));parentPort.close();
