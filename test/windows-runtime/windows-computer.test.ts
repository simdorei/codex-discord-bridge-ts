import test from 'node:test';
import assert from 'node:assert/strict';
import {windowNativeOperation,createWindowsComputer,requireProjectKeys} from '../../src/remote-agent/windows-computer.ts';
import {quoteWindowsArgument,WindowsWindowProcess} from '../../src/runtime/windows/windows-window-process.ts';
import {encodeWindowsBitmapPng} from '../../src/runtime/windows/png.ts';
import {terminalEnvironment} from '../../src/remote-agent/native-terminal.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
const windows={skip:process.platform!=='win32'};
test('actual read-only Windows enumeration joins without exposing titles in diagnostics',windows,async()=>{
 const result=await windowNativeOperation({kind:'list'});assert.ok(Array.isArray(result));assert.equal(ownedWorkerUsage().Background,0);
 const controller=await createWindowsComputer('project');try{assert.deepEqual(await controller.execute({kind:'computer_list_windows'}),{kind:'computer_windows',windows:[]});await assert.rejects(controller.execute({kind:'computer_activate',window_id:1n}));}finally{await controller.stop();}
});
test('native suspended process is enrolled before running and exact owned job closes',windows,async()=>{
 const child=await WindowsWindowProcess.launch(process.execPath,['-e','setInterval(()=>{},1000)'],process.cwd(),terminalEnvironment());assert.equal(child.running(),true);await child.close();assert.equal(child.running(),false);await child.close();
});
test('PNG conversion, Windows argument quoting and restricted project shortcuts',()=>{
 const png=encodeWindowsBitmapPng(2,1,Buffer.from([0,0,255,0,0,255,0,0]));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),2);assert.equal(quoteWindowsArgument('a b\\'),'"a b\\\\"');assert.equal(quoteWindowsArgument('abc'),'abc');requireProjectKeys(['CTRL','A']);assert.throws(()=>requireProjectKeys(['ALT','F4']));
});
