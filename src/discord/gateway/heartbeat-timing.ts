import {rustDurationMulF64} from '../../core/rust-duration.ts';
/** Native Node draw policy, with source Duration float conversion. The PRNG's
 * sequence is not fastrand's sequence; supplied draws make the arithmetic testable. */
export function gatewayHeartbeatJitter(intervalNs:bigint,unit=Math.random()):bigint{if(typeof unit!=='number'||!Number.isFinite(unit)||unit<0||unit>=1)throw new TypeError('Expected heartbeat jitter draw in [0,1)');return rustDurationMulF64(intervalNs,unit);}
/** Tokio 1.53.1 Delay: lateness up to and including 5ms preserves the original
 * phase. Only a larger delay schedules from now. Platform Instant overflow and
 * actual OS scheduling precision are outside this integer-clock helper. */
export function nextGatewayHeartbeatDeadline(previous:bigint,now:bigint,period:bigint):bigint{if(typeof previous!=='bigint'||typeof now!=='bigint'||typeof period!=='bigint'||previous<0n||now<previous||period<=0n)throw new TypeError('Invalid heartbeat deadline');return (now>previous+5000000n?now:previous)+period;}
