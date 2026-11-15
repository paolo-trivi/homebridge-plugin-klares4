import { isCfgCoherentWithRealtime, type ThermostatRealtimeView } from './thermostat-config-sync';

/** Whether a guessed cfg id may be written, and whether it may be remembered for the session. */
export type DegradedGuessVerdict =
    | { accepted: true; remember: boolean }
    | { accepted: false; reason: string };

/**
 * Without PRG_THERMOSTATS the cfg id of a thermostat is a guess, checked
 * against what the thermostat reports in realtime (STATUS_TEMPERATURES, keyed
 * by its sensor). A match alone proves little: in AUTO or OFF every cfg in the
 * same mode and season matches, and in winter that is most of them. The guess
 * is accepted only when it is the one cfg (of all those read from the panel)
 * matching this realtime state, and this realtime state the one matching the
 * cfg. It is remembered for the session only when the match was
 * discriminating (MAN, same setpoint); otherwise it is checked again at every
 * write.
 */
export function judgeDegradedGuess(
    candidateId: string,
    realtimeKey: string,
    cfgs: ReadonlyMap<string, Record<string, unknown>>,
    snapshots: ReadonlyMap<string, ThermostatRealtimeView>,
): DegradedGuessVerdict {
    const realtime = snapshots.get(realtimeKey);
    if (!realtime) return { accepted: false, reason: 'there is no realtime state of this thermostat to check it against' };
    const cfg = cfgs.get(candidateId);
    if (!isCfgCoherentWithRealtime(cfg, realtime)) {
        return { accepted: false, reason: `cfg ${candidateId} does not match what this thermostat reports in realtime` };
    }
    const matchingCfgs = [...cfgs].filter(([, other]) => isCfgCoherentWithRealtime(other, realtime)).map(([id]) => id);
    if (matchingCfgs.length > 1) {
        return {
            accepted: false,
            reason: `cfgs ${matchingCfgs.join(', ')} all match what this thermostat reports in realtime, so which one is its own cannot be told`,
        };
    }
    const matchingSensors = [...snapshots].filter(([, other]) => isCfgCoherentWithRealtime(cfg, other)).map(([key]) => key);
    if (matchingSensors.length > 1) {
        return {
            accepted: false,
            reason: `cfg ${candidateId} matches the realtime state of several thermostats (sensors ${matchingSensors.join(', ')})`,
        };
    }
    return { accepted: true, remember: realtime.mode === 'heat' || realtime.mode === 'cool' };
}
