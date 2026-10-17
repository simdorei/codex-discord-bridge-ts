import {types} from 'node:util';
import {invokeSynchronousVoid} from './synchronous-void.ts';

export type WorkQueuePoll<T> = {readonly kind: 'Value'; readonly value: T} | {readonly kind: 'Empty'} | {readonly kind: 'Closed'};
export interface OwnedWorkReservation<T> {
  /** Consumes the reservation; the temporary source Sender returned by send is dropped. */
  send(value: T): void;
  release(): boolean;
}
export type WorkReservationAttempt<T> =
  | {readonly kind: 'Reserved'; readonly reservation: OwnedWorkReservation<T>}
  | {readonly kind: 'Full' | 'Closed'};
export interface OwnedWorkSender<T> {
  tryReserve(): WorkReservationAttempt<T>;
  clone(): OwnedWorkSender<T>;
  dispose(): void;
}
export interface OwnedWorkReceiver<T> {
  tryReceive(): WorkQueuePoll<T>;
  receive(signal?: AbortSignal): Promise<Exclude<WorkQueuePoll<T>, {kind: 'Empty'}>>;
  close(): void;
  dispose(): void;
}
const senders = new WeakSet<object>();
export function isOwnedWorkSender(value: unknown): value is OwnedWorkSender<unknown> {
  return value !== null && typeof value === 'object' && senders.has(value);
}

/** Single-event-loop equivalent of the runtime's clone().try_reserve_owned()
 * profile. Explicit dispose/release replaces Rust Drop. It is a logical item cap,
 * not a heap budget, cross-thread synchronization or complete Tokio channel API.
 * close drains outstanding permits; receiver disposal drops current items, while
 * later permit sends retain ownership until the last sender/reservation is gone. */
export function createOwnedWorkQueue<T>(capacity: number, dropValue: (value: T) => void) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError('Expected positive supported queue capacity');
  if (typeof dropValue !== 'function' || types.isProxy(dropValue) || types.isAsyncFunction(dropValue)
      || types.isGeneratorFunction(dropValue)) throw new TypeError('Expected synchronous queue value disposer');
  const items: T[] = [];
  let references = 0, reserved = 0, closed = false, disposed = false, receiving = false, draining = false;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  const dropBuffered = (): void => {
    if (draining) return;
    draining = true;
    const errors: unknown[] = [];
    try {
      while (items.length !== 0) {
        const value = items.shift()!;
        try {invokeSynchronousVoid(dropValue, {}, [value]);} catch (error) {errors.push(error);}
      }
    } finally {draining = false;}
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Work queue value cleanup failed');
  };
  const releaseReference = (): void => {
    references--;
    notify();
    if (disposed && references === 0) dropBuffered();
  };
  const makeSender = (): OwnedWorkSender<T> => {
    references++;
    let live = true;
    const sender: OwnedWorkSender<T> = Object.freeze({
      tryReserve: (): WorkReservationAttempt<T> => {
        if (!live) throw new TypeError('Sender was disposed');
        if (closed || disposed) return Object.freeze({kind: 'Closed'});
        if (items.length + reserved >= capacity) return Object.freeze({kind: 'Full'});
        reserved++; references++;
        let active = true;
        const reservation: OwnedWorkReservation<T> = Object.freeze({
          send: (value: T): void => {
            if (!active) throw new TypeError('Reservation was already consumed');
            active = false; reserved--;
            items.push(value);
            releaseReference();
          },
          release: (): boolean => {
            if (!active) return false;
            active = false; reserved--;
            releaseReference(); return true;
          },
        });
        return Object.freeze({kind: 'Reserved', reservation});
      },
      clone: (): OwnedWorkSender<T> => {
        if (!live) throw new TypeError('Sender was disposed');
        return makeSender();
      },
      dispose: (): void => {
        if (!live) return;
        live = false; releaseReference();
      },
    });
    senders.add(sender); return sender;
  };
  const poll = (): WorkQueuePoll<T> => {
    if (disposed) return Object.freeze({kind: 'Closed'});
    if (items.length !== 0) return Object.freeze({kind: 'Value', value: items.shift()!});
    return Object.freeze({kind: references === 0 || (closed && reserved === 0) ? 'Closed' : 'Empty'});
  };
  const close = (): void => {closed = true; notify();};
  const receiver: OwnedWorkReceiver<T> = Object.freeze({
    tryReceive: (): WorkQueuePoll<T> => {
      if (receiving) throw new TypeError('Concurrent work queue receive');
      return poll();
    },
    receive: async (signal?: AbortSignal) => {
      if (receiving) throw new TypeError('Concurrent work queue receive');
      receiving = true;
      try {
        for (;;) {
          signal?.throwIfAborted();
          const result = poll();
          if (result.kind !== 'Empty') return result;
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {wake = undefined; signal?.removeEventListener('abort', abort);};
            const abort = () => {cleanup(); reject(signal?.reason);};
            wake = () => {cleanup(); resolve();};
            signal?.addEventListener('abort', abort, {once: true});
          });
        }
      } finally {receiving = false;}
    },
    close,
    dispose: (): void => {
      if (disposed) return;
      disposed = true; close(); dropBuffered();
    },
  });
  return Object.freeze({
    sender: makeSender(), receiver,
    snapshot: () => Object.freeze({capacity, queued: items.length, reserved, senders: references - reserved,
      receiverClosed: closed, receiverDisposed: disposed}),
  });
}
