'use strict';

const PORTS = Object.freeze({
  STATUS: 'status',
  AIR: 'air',
  FILTER: 'fltsts',
  DEVICE: 'device',
  SECURITY: 'security',
  FIRMWARE: 'firmware',
  AIRFRYER: 'airfryer',
  VENUS_1: 'venus1af',
  VENUS_2: 'venusaf',
  NUTRIMAX: 'nutrimax',
  HERMES: 'hermesac',
  DEVICE_CURRENT_STATE: 'devcurrstate',
  AUTOCOOK: 'autocookprogram',
  RECIPE: 'recipe',
  MACHINE_STATUS: 'machinestatus',
  CONFIGURATION: 'configuration',
  COMMAND: 'command',
  BASIC_RECIPE: 'command/BasicRecipe',
});

const MODEL_PORTS = Object.freeze({
  HD9200: PORTS.AIRFRYER,
  HD9255: PORTS.AIRFRYER,
  HD9280: PORTS.AIRFRYER,
  HD9285: PORTS.AIRFRYER,
  HD9875: PORTS.VENUS_1,
  HD9876: PORTS.VENUS_1,
  HD9880: PORTS.VENUS_2,
  NX0950: PORTS.HERMES,
  NX0960: PORTS.NUTRIMAX,
});

const VENUS_PORTS = new Set([
  PORTS.VENUS_1,
  PORTS.VENUS_2,
  PORTS.NUTRIMAX,
  PORTS.HERMES,
]);

const ACTIVE_COOKING_STATES = new Set([
  'cooking', 'pause', 'setting', 'precook', 'parasetting', 'maintain',
  'user_action', 'idle', 'finish',
]);

const CLOUD = Object.freeze({
  GIGYA_API_KEY: '4_JGZWlP8eQHpEqkvQElolbA',
  GIGYA_API_URL: 'https://cdc.accounts.home.id',
  OAUTH_CLIENT_ID: '-u6aTznrxp9_9e_0a57CpvEG',
  MOBILE_REDIRECT_URI: 'com.philips.ka.oneka.app.prod://oauthredirect',
  AIRPLUS_CLIENT_ID: '-XsK7O6iEkLml77yDGDUi0ku',
  AIRPLUS_REDIRECT_URI: 'com.philips.air://loginredirect',
  IOT_BASE: 'https://prod.eu-da.iot.versuni.com/api/da',
  BACKEND_BASE: 'https://www.backend.vbs.versuni.com',
  BACKEND_API_BASE: 'https://www.backend.vbs.versuni.com/api',
  HOMEID_ACCEPT: 'application/vnd.oneka.v2.0+json',
  FUSION_TENANT: 'da',
  FUSION_MQTT_HOST: 'ats.prod.eu-da.iot.versuni.com',
  FUSION_PLATFORM_REST_URL: 'prod.eu-da.iot.versuni.com',
});

function normalizeId(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function portForModel(model = '') {
  const normalized = String(model).toUpperCase();
  return Object.entries(MODEL_PORTS).find(([prefix]) => normalized.includes(prefix))?.[1] || null;
}

function deviceTypeForModel(model = '') {
  const value = String(model).toUpperCase();
  if (/\b(AC0650|AC0651|AC1715)\b/.test(value)) return 'air_purifier';
  if (/\b(NX0950|NX0960)\b/.test(value)) return 'multicooker';
  if (/\b(EP\d+|SM\d+|RITA|FLASH_ENTRY_P)\b/.test(value)) return 'espresso';
  if (/\b(HD9200|HD9255|HD9280|HD9285|HD9875|HD9876|HD9880|SPECTRE|VENUS)\b/.test(value)) return 'airfryer';
  return 'airfryer';
}

module.exports = {
  ACTIVE_COOKING_STATES,
  CLOUD,
  MODEL_PORTS,
  PORTS,
  VENUS_PORTS,
  deviceTypeForModel,
  normalizeId,
  portForModel,
};
