import {mkdir,copyFile} from 'node:fs/promises';
const destination=new URL('../plugins/codex-discord-remote/lib/pro/',import.meta.url);
await mkdir(destination,{recursive:true});
for(const leaf of ['main.js','conversation.js','evidence.js'])await copyFile(new URL('../dist/src/pro/helper/'+leaf,import.meta.url),new URL(leaf,destination));
