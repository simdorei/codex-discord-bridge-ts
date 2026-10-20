import {lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {joinRuntimePath} from '../runtime/runtime-paths/path-text.ts';

/** Preserve a runtime-local plugin installation. npm installations keep the
 * manifest and explicit turn skill input together in the shipped package. */
export async function runtimePluginPaths(root:string):Promise<Readonly<{manifest:string;proSkill:string}>>{
 const platform=process.platform==='win32'?'win32':'posix';
 let plugin=joinRuntimePath(root,'plugins/codex-discord-remote',platform);
 try{await lstat(joinRuntimePath(plugin,'.codex-plugin/plugin.json',platform));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;plugin=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../plugins/codex-discord-remote/':'../../../plugins/codex-discord-remote/',import.meta.url));}
 return Object.freeze({manifest:joinRuntimePath(plugin,'.codex-plugin/plugin.json',platform),proSkill:joinRuntimePath(plugin,'skills/ask-chatgpt-pro/SKILL.md',platform)});
}
