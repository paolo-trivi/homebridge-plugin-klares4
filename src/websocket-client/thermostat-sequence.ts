import type { WebSocketClientState } from './types';

/**
 * The next number of the client's thermostat event sequence. Every event that
 * may decide "which is newer" (a realtime observation, a cfg read, an ACK of
 * ours) takes one when it is processed: a total order, with no ties, that does
 * not depend on the clock (two events often share a millisecond).
 */
export function nextThermostatEventSeq(state: WebSocketClientState): number {
    state.thermostatEventSeq = (state.thermostatEventSeq ?? 0) + 1;
    return state.thermostatEventSeq;
}
