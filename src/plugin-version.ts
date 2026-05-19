import { version as RAW_VERSION } from '../package.json';

// FirmwareRevision conforme HAP/Matter: solo MAJOR.MINOR.PATCH, senza suffissi.
// Matter rifiuta suffissi tipo `-beta0`, `-rc1`, `+build`.
// Es: "2.1.0-beta0" → "2.1.0", "2.1.0" → "2.1.0".
export const PLUGIN_VERSION: string = RAW_VERSION.split(/[-+]/)[0];

export const PLUGIN_VERSION_RAW: string = RAW_VERSION;
