import {parentPort, workerData as input} from 'node:worker_threads';
import {statSync} from 'node:fs';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {RoomCleanupProtectedError} from '../../store/room-cleanup.ts';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {mirrorRolloutAvailable} from './source-metadata-local.ts';
const port = parentPort;
if (port === null) throw new Error('Owned archived cleanup worker required');
const binding = {id: input.id, codex: input.codex, mirror: input.mirror, kind: input.kind};
try {

  let value: string | null;
  if (input.kind === 'Pending') value = state.archivedCleanupPendingReason(input.mirror, input.channel, input.target, input.now);
  else if (input.kind === 'Begin') {
    const original = statSync(input.codex, {bigint: true}); let mirror;
    try { mirror = statSync(input.mirror, {bigint: true}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (mirror !== undefined && mirror.dev === original.dev && mirror.ino === original.ino) throw new Error('Codex state and bridge store must differ');
    const store = CodexThreadStore.open(input.codex), expected = input.expected;
    value = await state.beginArchivedCleanup(input.mirror, input.channel, input.target, input.parent, input.now, () => {
      if (store.loadThread(expected.id, false) !== null) throw new Error('Archived source restored; no deletion authorized');
      const current = store.loadThread(expected.id, true);
      if (current === null || current.archivedAt <= 0n || current.archivedAt !== expected.archivedAt || current.rolloutPath !== expected.rolloutPath || !mirrorRolloutAvailable(current.rolloutPath)) throw new Error('Archived source changed or unavailable');
      return serializeSerdeValue({thread_id: current.id, archived: true, archived_at: current.archivedAt, rollout_path: current.rolloutPath, state_db: store.path(), notification_confirmation: 'unknown-preserved', policy: 'archived-expired-steer-non-dispatch-v1'});
    });
  } else throw new TypeError('Unsupported archived cleanup query');
  port.postMessage({...binding, ok: true, value});
} catch (error) {
  if (input.kind === 'Begin' && error instanceof RoomCleanupProtectedError) port.postMessage({...binding, ok: false, protected: {channel: error.channel, reason: error.reason}});
  else port.postMessage({...binding, ok: false});
} finally { port.close(); }
