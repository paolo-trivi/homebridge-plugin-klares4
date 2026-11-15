/**
 * The ranges HomeKit accepts for the characteristics the plugin feeds from
 * panel readings. A value outside them makes hap-nodejs reject the update, so
 * every accessory holds a reading to the same limits before publishing it.
 */
export const clampHapTemperature = (value: number): number => Math.max(-270, Math.min(100, value));
export const clampHapHumidity = (value: number): number => Math.max(0, Math.min(100, value));
export const clampHapLux = (value: number): number => Math.max(0.0001, Math.min(100000, value));
