import {createRequire} from 'node:module';
import {win32} from 'node:path';

type Native = (...args: any[]) => any;
let api: {open:Native; info:Native; close:Native; error:Native}|undefined;
// An unsuccessful CloseHandle is ownership debt, never an invitation to retry a
// numeric handle which the OS might already have recycled.
const retained = new Set<WindowsFilePin>();
function binding() {
  if (process.platform !== 'win32' || !['x64','arm64'].includes(process.arch)) throw new Error('Windows file handles require a 64-bit Windows host');
  if (api) return api;
  const koffi = createRequire(import.meta.url)('koffi');
  if (koffi.version !== '3.3.3') throw new Error('Unsupported Windows binding version');
  const library = koffi.load('kernel32.dll');
  api = {
    open:library.func('void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)'),
    info:library.func('int32_t __stdcall GetFileInformationByHandle(void *handle, _Out_ void *info)'),
    close:library.func('int32_t __stdcall CloseHandle(void *handle)'),
    error:library.func('uint32_t __stdcall GetLastError(void)'),
  };
  return api;
}
export class WindowsFilePinError extends Error {
  constructor(readonly operation:string, readonly win32Code:number) {super(`Windows file ownership failed (${operation}/${win32Code})`);this.name='WindowsFilePinError';}
}
export interface WindowsFileIdentity {readonly volume:number;readonly index:bigint;readonly attributes:number;readonly links:number;}
function extended(path:string):string {
  if(path.startsWith('\\\\?\\'))return path;
  return path.startsWith('\\\\')?'\\\\?\\UNC\\'+path.slice(2):'\\\\?\\'+path;
}
/** Pins every pathname component against rename/deletion. OPEN_REPARSE_POINT
 * observes the entry itself, including non-symlink reparse tags. The handles
 * grant no write access and intentionally omit FILE_SHARE_DELETE. Writers may
 * still change content; callers must retain their before/after content checks. */
export class WindowsFilePin {
  readonly #handles:bigint[]=[]; #closed=false; #failure:unknown;
  private constructor(){}
  static acquire(input:string, leaf:'directory'|'file', singleLink=false, update=false):WindowsFilePin {
    if(typeof input!=='string'||input.includes('\0')||input.length>32760||!win32.isAbsolute(input)||input.startsWith('\\\\.\\'))throw new TypeError('Expected absolute Windows filesystem path');
    let source=input;if(source.startsWith('\\\\?\\UNC\\'))source='\\\\'+source.slice(8);else if(/^\\\\\?\\[a-z]:\\/i.test(source))source=source.slice(4);else if(source.startsWith('\\\\?\\'))throw new TypeError('Device namespaces are not filesystem roots');
    const path=win32.normalize(source),root=win32.parse(path).root;
    if(!root||(!/^[a-z]:\\$/i.test(root)&&!/^\\\\[^\\?\.]+\\[^\\]+\\$/.test(root)))throw new TypeError('Expected drive or UNC root');
    const components=path.slice(root.length).split('\\').filter(Boolean);
    if(components.some(p=>p.includes(':')||p==='..'||p==='.'||/[. ]$/.test(p)))throw new TypeError('Unsafe Windows filesystem component');
    const pin=new WindowsFilePin();retained.add(pin);
    try {
      const names=[root];let current=root;
      for(const part of components){current=win32.join(current,part);names.push(current);}
      const native=binding();
      for(let i=0;i<names.length;i++) {
        const share=update&&leaf==='file'&&i===names.length-1?0x5:0x3;
        const handle:unknown=native.open(extended(names[i]!),0x80000000,share,null,3,0x02200000,null),code=native.error();
        if(typeof handle!=='bigint'||handle===0n||handle===-1n||handle===0xffffffffffffffffn)throw new WindowsFilePinError('open',code);
        pin.#handles.push(handle);
        const info=pin.#identity(handle);
        if(info.attributes&0x400)throw new WindowsFilePinError('reparse-point',0);
        const directory=i<names.length-1||leaf==='directory';
        if(Boolean(info.attributes&0x10)!==directory)throw new WindowsFilePinError('entry-type',0);
        if(!directory&&singleLink&&info.links!==1)throw new WindowsFilePinError('hard-link',0);
      }
      return pin;
    }catch(error){try{pin.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Windows file pin cleanup failed');}throw error;}
  }
  #identity(handle:bigint):WindowsFileIdentity {
    const native=binding(),bytes=Buffer.alloc(52),ok=native.info(handle,bytes),code=native.error();
    if(ok===0)throw new WindowsFilePinError('identity',code);
    return Object.freeze({attributes:bytes.readUInt32LE(0),volume:bytes.readUInt32LE(28),links:bytes.readUInt32LE(40),index:(BigInt(bytes.readUInt32LE(44))<<32n)|BigInt(bytes.readUInt32LE(48))});
  }
  identity():WindowsFileIdentity {if(this.#closed)throw new Error('File pin is closed');return this.#identity(this.#handles.at(-1)!);}
  close():void {
    if(this.#closed){if(this.#failure)throw this.#failure;return;}
    this.#closed=true;const native=binding();const failures:unknown[]=[];
    for(const handle of [...this.#handles].reverse())try{const ok=native.close(handle),code=native.error();if(ok===0)failures.push(new WindowsFilePinError('close',code));}catch(error){failures.push(error);}
    if(failures.length){this.#failure=new AggregateError(failures,'Windows file handles remain unconfirmed');throw this.#failure;}
    retained.delete(this);
  }
}
