import { version as RAW_VERSION } from '../package.json';

// The FirmwareRevision HAP and Matter accept: MAJOR.MINOR.PATCH only.
// Matter refuses suffixes such as `-beta.1`, `-rc.1`, `+build`.
// "2.3.0-rc.1" → "2.3.0", "2.3.0" → "2.3.0".
export const PLUGIN_VERSION: string = RAW_VERSION.split(/[-+]/)[0] ?? RAW_VERSION;

export const PLUGIN_VERSION_RAW: string = RAW_VERSION;
