import {createWindowsNativeBinding, type WindowsNativeBinding} from './windows-native.ts';
import {toNamespacedPath} from 'node:path';
let binding: WindowsNativeBinding | undefined;

/** Synchronous bridge-state leaf, normally executed inside its owned I/O worker.
 * The caller fsyncs/closes its exclusive temporary file before replacement. */
export function replaceWindowsFileSync(source: string, destination: string): void {
  const result = (binding ??= createWindowsNativeBinding()).moveReplaceWriteThroughSync(toNamespacedPath(source), toNamespacedPath(destination));
  if (result.kind === 'binding-error') throw result.error;
  if (result.value === 0) throw new Error(`Windows file replacement failed (${result.lastError})`);
}
