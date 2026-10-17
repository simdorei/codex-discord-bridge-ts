import {createPersistentResidentRegistration,constructPersistentResidentWorker,type PersistentResidentPreparation} from './persistent-resident-store-role.ts';
/** Internal component preparation only, deliberately NOT a runtime start API.
 * Future start must retain the original acquired guard and resolved RuntimePaths.
 * This helper cannot run resident services or a child and confers no authority. */
export function preparePersistentResident(path:string,runtimeId:string):PersistentResidentPreparation{
 return constructPersistentResidentWorker(createPersistentResidentRegistration(path),runtimeId);
}
