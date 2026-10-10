import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export async function storeFixture(run: (path: string) => Promise<void>): Promise<void> {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "cdr-cloud-store-"));
  const initial = realpathSync(root);
  const identity = lstatSync(root);
  try { await run(join(root, "store.sqlite")); }
  finally {
    assert.equal(realpathSync(root), initial);
    assert.equal(dirname(initial), parent);
    const current = lstatSync(root);
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    rmSync(root, {recursive: true});
  }
}
