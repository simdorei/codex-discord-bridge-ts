/** Exact source intent selection. Privileged members/presence are excluded;
 * message content is enabled only by the explicit runtime configuration flag. */
const BASE_BITS=[0,2,3,4,5,6,7,9,10,11,12,13,14,16,20,21,24,25] as const;
const BASE=BASE_BITS.reduce((value,bit)=>value|(1n<<BigInt(bit)),0n);
export function gatewayIntents(messageContent:boolean):bigint{if(typeof messageContent!=='boolean')throw new TypeError('Expected message content boolean');return messageContent?BASE|(1n<<15n):BASE;}
