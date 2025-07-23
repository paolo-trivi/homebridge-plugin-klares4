import { API } from 'homebridge';
import { Lares4Platform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export = (api: API) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, Lares4Platform);
}; 