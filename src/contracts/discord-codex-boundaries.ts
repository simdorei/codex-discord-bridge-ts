/**
 * Interface-only boundary definitions adapted from Rust crates:
 * - cdr-runtime::discord_dispatch (sha256: 1cd0920f6e8ca8bcb6e3fe838e9970c7d2936ef1b8f3c6a142061787ef533e93)
 * - cdr-app-server::manager::events (sha256: a683afcdf613a55ef3c7b74522b828fa86e4832e86b1c5583080d5806dacd953)
 * - cdr-app-server::client::pending (sha256: e16e0c093507264b731c1af81aa3d0b95c6eadabbc83641784f5b382f29513c7)
 * - cdr-runtime::message_worker::admission (sha256: 2287608944192b3d85eaadb7e42ce60a83e1d005a5dd657ffefc9c0746429f06)
 */

declare const __brand: unique symbol;
type Brand<B extends string> = { readonly [__brand]: B };

export type RoutedWork = Brand<'RoutedWork'>;
export type InteractionResponse = Brand<'InteractionResponse'>;
export type BusyChoice = Brand<'BusyChoice'>;
export type PathBuf = Brand<'PathBuf'>;
export type Notification = Brand<'Notification'>;
export type ServerRequest = Brand<'ServerRequest'>;
export type SerdeValue = Brand<'SerdeValue'>;
export type RpcErrorPayload = Brand<'RpcErrorPayload'>;
export type RestartGateAdmissionPermit = Brand<'RestartGateAdmissionPermit'>;
export type ClientLifecycleAdmissionPermit = Brand<'ClientLifecycleAdmissionPermit'>;
export type DrainGateError = Brand<'DrainGateError'>;

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface InteractionTransport {
  acknowledge(
    id: bigint,
    token: string,
    response: InteractionResponse,
  ): Promise<Result<void, string>>;
  update(
    token: string,
    content: string,
  ): Promise<Result<void, string>>;
}

export type InteractionProcessingMode =
  | 'Execute'
  | 'ConfirmationOnly';

export interface InboundInteractionWork {
  readonly applicationId: bigint;
  readonly interactionId: bigint;
  readonly channelId: bigint;
  readonly userId: bigint;
  readonly sourceMessageId: bigint | null;
  readonly interactionToken: string;
  readonly work: RoutedWork;
  readonly processingMode: InteractionProcessingMode;
  readonly custodyDatabase: PathBuf;
  readonly custodyIngressId: string;
  readonly authorizedBusyChoice: BusyChoice | null;
  readonly admissionPermit: RestartGateAdmissionPermit | null;
}

export type DispatchOutcome =
  | 'Queued'
  | 'RespondedWithoutWork'
  | 'Duplicate'
  | 'DuplicatePending'
  | 'DeadlineExceeded'
  | 'QueueFull'
  | 'Stopping';

export type DiscordDispatchError =
  | { readonly kind: 'Acknowledge'; readonly message: string }
  | { readonly kind: 'Update'; readonly message: string }
  | { readonly kind: 'ClaimCacheSaturated' }
  | { readonly kind: 'ClaimState' }
  | { readonly kind: 'Custody'; readonly message: string }
  | { readonly kind: 'Admission'; readonly error: DrainGateError };

export type ResidentNotificationEvent =
  | { readonly kind: 'Notification'; readonly generation: bigint; readonly notification: Notification }
  | { readonly kind: 'Gap'; readonly generation: bigint; readonly skipped: bigint };

export type ResidentServerRequestEvent =
  | { readonly kind: 'Request'; readonly generation: bigint; readonly request: ServerRequest }
  | { readonly kind: 'Gap'; readonly generation: bigint; readonly skipped: bigint };

export type PendingOutcome =
  | { readonly kind: 'Response'; readonly result: Result<SerdeValue, RpcErrorPayload> }
  | { readonly kind: 'TransportClosed'; readonly reason: string }
  | { readonly kind: 'Timeout' };
