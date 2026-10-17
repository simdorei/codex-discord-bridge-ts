import assert from 'node:assert/strict';
import {API} from 'typescript/unstable/sync';
import * as ts from 'typescript/unstable/ast';
import {join,relative} from 'node:path';
/** Syntax-aware closed native surface audit. Native constructor aliases,
 * namespace/default imports, reexports and dynamic loads fail closed rather
 * than relying on constructor-name regexes. Only production files are parsed. */
export function auditStoreAuthoritySyntax(root:string,files:readonly string[]):void{
 const config=join(root,'__authority_audit__.json'),api=new API({cwd:root,fs:{readFile:path=>path===config?JSON.stringify({compilerOptions:{allowJs:true,noEmit:true,target:'ESNext',module:'NodeNext',moduleResolution:'NodeNext',skipLibCheck:true},files}):undefined,fileExists:path=>path===config?true:undefined}});
 try{
  const snapshot=api.updateSnapshot({openProjects:[config]}),program=snapshot.getProjects()[0]!.program;
  try{for(const path of files){const file=program.getSourceFile(path);assert.ok(file,path);auditFile(file,relative(root,path).replaceAll('\\','/'));}}finally{snapshot.dispose();}
 }finally{api.close();}
}
function auditFile(file:ts.SourceFile,name:string):void{
 const normalized=name.replace(/\.js$/,'.ts'),protectedNames=new Set(['Worker','DatabaseSync','getEnvironmentData','setEnvironmentData']);
 const native=(value:string)=>['node:worker_threads','worker_threads','node:sqlite','sqlite'].includes(value);
 const importOwners:Record<string,readonly string[]>={
  'requireStoreAuthorityPath':['runtime/runtime-instance.ts'],
  'openAuthorityConnection':['store/existing-store.ts','store/owned-driver.ts'],
  'registerStoreWriter':['store/authority-connection.ts','runtime/store-worker-authority.ts'],
  'releaseStoreWriter':['store/authority-connection.ts','runtime/store-worker-authority.ts'],
  'reopenStoreWriter':['store/authority-connection.ts'],
  'markStoreWorkerSubmitted':['runtime/store-worker-authority.ts'],
  'registerStoreWorker':['runtime/owned-worker-slot.ts'],
  'constructStoreWorker':['runtime/owned-worker-slot.ts'],
  'releaseStoreWorker':['runtime/owned-worker-slot.ts'],
 };
 function visit(node:ts.Node):void{
  if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
   const clause=node.importClause;
   if(node.moduleSpecifier.text==='node:module'||node.moduleSpecifier.text==='module')assert.fail(name+' native module loader requires review');
   if(native(node.moduleSpecifier.text)){
    assert.equal(clause?.name,undefined,name+' default native import');assert.ok(clause?.namedBindings&&ts.isNamedImports(clause.namedBindings),name+' namespace/side-effect native import');
    for(const specifier of clause.namedBindings.elements){const imported=specifier.propertyName?.text??specifier.name.text;
     if(protectedNames.has(imported)){assert.equal(specifier.name.text,imported,name+' native alias');if(imported==='Worker'&&clause.phaseModifier!==ts.SyntaxKind.TypeKeyword&&!specifier.isTypeOnly)assert.equal(normalized,'runtime/owned-worker-slot.ts');if(imported.endsWith('EnvironmentData'))assert.equal(normalized,'runtime/store-worker-authority.ts');}
    }
   }
   if(clause?.namedBindings&&ts.isNamedImports(clause.namedBindings))for(const specifier of clause.namedBindings.elements){const imported=specifier.propertyName?.text??specifier.name.text,owners=importOwners[imported];if(owners!==undefined){assert.ok(owners.includes(normalized),name+' unauthorized ownership import '+imported);assert.equal(specifier.name.text,imported,name+' ownership alias');}}
  }
  if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))assert.equal(native(node.moduleSpecifier.text),false,name+' native reexport');
  if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
   const argument=node.arguments[0];if(argument&&ts.isStringLiteral(argument))assert.equal(native(argument.text),false,name+' dynamic native load');else if(node.expression.kind===ts.SyntaxKind.ImportKeyword||!['runtime/server-request-delivery.ts','store/mirror-project-creation.ts'].includes(normalized))assert.fail(name+' computed module load requires review');
  }
  if(ts.isPropertyAccessExpression(node)&&node.name.text==='getBuiltinModule')assert.fail(name+' native module lookup requires review');
  if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='DatabaseSync'){
   const options=node.arguments?.[1];assert.ok(options&&ts.isObjectLiteralExpression(options),name+' native database options must be explicit');
   assert.ok(options.properties.every(p=>ts.isPropertyAssignment(p)),name+' dynamic database options');
   const readonly=options.properties.filter(p=>ts.isPropertyAssignment(p)&&(ts.isIdentifier(p.name)||ts.isStringLiteral(p.name))&&p.name.text==='readOnly');
   assert.equal(readonly.length,1,name+' raw writable native database');assert.equal((readonly[0] as ts.PropertyAssignment).initializer.kind,ts.SyntaxKind.TrueKeyword,name+' raw writable native database');
  }
  if(ts.isIdentifier(node)&&(node.text==='Worker'||node.text==='DatabaseSync')){
   const p=node.parent;
   if(ts.isImportSpecifier(p)||ts.isTypeReferenceNode(p)||ts.isTypeQueryNode(p)||ts.isNewExpression(p)||ts.isExpressionWithTypeArguments(p)){}
   else if(ts.isPropertyAccessExpression(p)&&p.expression===node&&p.name.text==='prototype'){
    const method=p.parent;assert.ok(ts.isPropertyAccessExpression(method)&&method.expression===p&&method.name.text==='location',name+' raw lifecycle/prototype bypass');
    assert.ok(normalized==='runtime/writer-recovery/native-repair-owner.ts'||normalized==='runtime/writer-recovery/native-repair-worker.ts',name+' unreviewed prototype operation');
   }else assert.fail(name+' native constructor escape: '+p.getText(file).slice(0,100));
  }
  node.forEachChild(visit);
 }
 visit(file);
}
