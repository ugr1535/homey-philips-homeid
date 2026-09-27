'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');
const { setTimeout: sleep } = require('node:timers/promises');
const PhilipsFusionApi = require('../lib/fusion-api');
const PhilipsLocalApi = require('../lib/local-api');
const { HttpClient } = require('../lib/http-client');

function createDevice(type, model, connection = 'local') {
  const filename = path.join(__dirname, '..', 'lib', 'base-device.js');
  const source = fs.readFileSync(filename, 'utf8');
  const realRequire = createRequire(filename);
  const context = { exports: {} };
  vm.runInNewContext(source, {
    module: context,
    exports: context.exports,
    require: (name) => (name === 'homey' ? { Device: class {} } : realRequire(name)),
  }, { filename });
  const DeviceClass = context.exports;
  const device = new DeviceClass();
  const values = new Map();
  const capabilities = new Set(['onoff', 'homeid_cooking_method']);
  const listeners = new Map();
  device.deviceType = type;
  device.values = values;
  device.capabilities = capabilities;
  device.listeners = listeners;
  device.getStoreValue = (key) => (key === 'connection' ? connection : undefined);
  device.settings = new Map([['model', model]]);
  device.getSetting = (key) => device.settings.get(key);
  device.setSettings = async(settings) => {
    for (const [key, value] of Object.entries(settings)) device.settings.set(key, value);
  };
  device.hasCapability = (key) => capabilities.has(key);
  device.addCapability = async(key) => { capabilities.add(key); };
  device.getCapabilityValue = (key) => values.get(key);
  device.setCapabilityValue = async(key, value) => { values.set(key, value); };
  device.registerCapabilityListener = (key, callback) => { listeners.set(key, callback); };
  device.setCapabilityOptions = async(key, options) => { device.options = { key, ...options }; };
  device.setAvailable = async() => {};
  device.error = () => {};
  return device;
}

test('purifier adds only reported sensors and writable settings to an existing device', async() => {
  const device = createDevice('air_purifier', 'AC1715', 'fusion');
  const writes = [];
  device.api = { connected: true, setPurifierSetting: async(...args) => { writes.push(args); } };
  device.schedulePoll = () => {};
  await device.applyState({
    powerOn: true,
    properties: { pm1: 7, pm10: 22, fltsts1: 72, D03130: 2, D03134: 1 },
  });
  assert.equal(device.values.get('homeid_pm1'), 7);
  assert.equal(device.values.get('homeid_pm10'), 22);
  assert.equal(device.values.get('homeid_filter_hepa'), 72);
  assert.equal(device.values.get('homeid_purifier_beep_volume'), 2);
  assert.equal(device.values.get('homeid_purifier_standby_monitor'), true);
  assert.equal(device.capabilities.has('homeid_tvoc'), false);
  await device.listeners.get('homeid_purifier_beep_volume')(3);
  assert.equal(writes[0][0], 'D03130');
  assert.equal(writes[0][1], 3);
});

test('local purifier mode codes and allergen index are not confused with FUSION AQI', async() => {
  const device = createDevice('air_purifier', 'AC0651');
  device.capabilities.add('homeid_operation_mode');
  device.capabilities.add('homeid_air_quality_index');
  device.api = {};
  assert.equal(device.purifierMode('2'), 'medium');
  await device.applyState({ powerOn: true, properties: { om: '2', aqit: 15 } });
  assert.equal(device.values.get('homeid_operation_mode'), 'medium');
  assert.equal(device.values.get('homeid_allergen_index'), 15);
  assert.equal(device.values.has('homeid_air_quality_index'), false);
});

test('cooking methods use the actual architecture and reject another model\'s IDs', async() => {
  const device = createDevice('multicooker', 'NX0950');
  device.api = { airfryerPort: 'hermesac' };
  assert.equal(device.validCookingMethod(60), '60');
  assert.equal(device.validCookingMethod(8), null);
  await device.updateCookingMethodOptions();
  assert.equal(device.options.values.find((item) => item.id === '60').title.en, 'Easy clean');
  const fryer = createDevice('airfryer', 'HD9280');
  fryer.api = { airfryerPort: 'airfryer' };
  assert.equal(fryer.validCookingMethod(8), '8');
  assert.equal(fryer.validCookingMethod(50), null);
});

test('optional cooking probe controls are added only when reported', async() => {
  const device = createDevice('airfryer', 'HD9880');
  const writes = [];
  device.api = { airfryerPort: 'venusaf', setCookingSettings: async(value) => { writes.push(value); } };
  device.schedulePoll = () => {};
  await device.applyState({
    powerOn: true,
    properties: { airfryer: { status: 'cooking', temp_probe: 75, current_temp_probe: 49, airspeed: 2, flip: true } },
  });
  assert.equal(device.values.get('homeid_probe_target'), 75);
  assert.equal(device.values.get('homeid_probe_current'), 49);
  assert.equal(device.values.get('homeid_flip_reminder'), true);
  await device.listeners.get('homeid_airspeed')(3);
  assert.equal(writes[0].airspeed, 3);
});

test('firmware is a read-only setting and legacy information capabilities stay current without being added anew', async() => {
  const device = createDevice('airfryer', 'HD9280');
  device.api = { airfryerPort: 'airfryer' };
  await device.applyState({
    powerOn: true,
    properties: { airfryer: { preheat: true, temp_unit: true }, firmware: { version: '1.2.3' } },
  });
  assert.equal(device.getSetting('firmware'), '1.2.3');
  assert.equal(device.capabilities.has('homeid_firmware'), false);
  assert.equal(device.capabilities.has('homeid_temp_unit_fahrenheit'), false);
  device.capabilities.add('homeid_firmware');
  device.capabilities.add('homeid_temp_unit_fahrenheit');
  await device.applyState({
    powerOn: true,
    properties: { airfryer: { preheat: false, temp_unit: false }, firmware: { version: '1.2.4' } },
  });
  assert.equal(device.getSetting('firmware'), '1.2.4');
  assert.equal(device.values.get('homeid_firmware'), '1.2.4');
  assert.equal(device.values.get('homeid_temp_unit_fahrenheit'), false);
  assert.equal(device.values.get('homeid_preheat'), undefined);
});

test('model and connection labels reflect the paired device rather than edited text', async() => {
  const device = createDevice('airfryer', 'Wrong model');
  device.settings.set('connection', 'fusion');
  device.getStoreValue = (key) => ({ model: 'HD9280', connection: 'local' })[key];
  assert.equal(device.getModel(), 'HD9280');
  await device.syncInformationalSettings();
  assert.equal(device.getSetting('model'), 'HD9280');
  assert.equal(device.getSetting('connection'), 'local');
});

test('Preheat uses a stateful button and keeps the existing true/false device command', async() => {
  const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.homeycompose', 'capabilities', 'homeid_preheat.json'), 'utf8'));
  assert.equal(definition.uiComponent, 'button');
  assert.equal(definition.getable, true);
  assert.equal(definition.setable, true);
  const device = createDevice('airfryer', 'HD9280');
  device.capabilities.add('homeid_preheat');
  const commands = [];
  device.api = { airfryerPort: 'airfryer', setCookingSettings: async(settings) => { commands.push(settings); } };
  device.schedulePoll = () => {};
  device.registerCapabilityListeners();
  await device.applyState({ powerOn: true, properties: { airfryer: { preheat: false } } });
  assert.equal(device.values.get('homeid_preheat'), false);
  await device.listeners.get('homeid_preheat')(true);
  assert.equal(commands[0].preheat, true);
  await device.applyState({ powerOn: true, properties: { airfryer: { preheat: true } } });
  assert.equal(device.values.get('homeid_preheat'), true);
});

test('FUSION coalesces a burst of state messages and clears timer on close', async() => {
  const api = new PhilipsFusionApi({ deviceType: 'airfryer', thingName: 'test' });
  let callbacks = 0;
  api.onState(() => { callbacks += 1; });
  for (let index = 0; index < 100; index += 1) {
    api.handleShadow({ state: { reported: { powerOn: true, sequence: index } } });
  }
  await sleep(140);
  assert.equal(callbacks, 1);
  assert.equal(api.getFullState().properties.sequence, 99);
  api.handleShadow({ state: { reported: { sequence: 100 } } });
  api.close();
  await sleep(120);
  assert.equal(callbacks, 1);
});

test('purifier control settings use the correct port and validate ranges', async() => {
  const api = new PhilipsFusionApi({ deviceType: 'air_purifier', thingName: 'test' });
  const calls = [];
  api.sendNcp = (...args) => { calls.push(args); };
  await api.setPurifierSetting('D0312C', 4);
  await api.setPurifierSetting('D03134', true);
  assert.equal(calls[0][0], 'control');
  assert.equal(calls[0][2].D0312C, 4);
  assert.equal(calls[1][2].D03134, 1);
  await assert.rejects(api.setPurifierSetting('D03130', 5), /Invalid/);
  api.close();
});

test('local firmware is cached instead of being requested on every poll', async() => {
  const api = new PhilipsLocalApi({ host: '127.0.0.1', model: 'HD9280' });
  const requested = [];
  api.request = async(port) => {
    requested.push(port);
    if (port === 'firmware') return { version: '1.0' };
    return { status: 'standby' };
  };
  try {
    await api.getFullState('airfryer');
    await api.getFullState('airfryer');
    assert.equal(requested.filter((port) => port === 'firmware').length, 1);
  } finally {
    api.close();
  }
});

test('cooking commands preserve the temperature unit reported by the appliance', async() => {
  const local = new PhilipsLocalApi({ host: '127.0.0.1', model: 'HD9280' });
  local.lastAirfryerStatus = { temp_unit: true };
  let sent;
  local.request = async(port, options) => { sent = options.data; return {}; };
  try {
    await local.setCookingSettings({ temperature: 190 });
    assert.equal(sent.temp_unit, true);
    await local.startCooking({ temperature: 190 });
    assert.equal(sent.temp_unit, true);
  } finally {
    local.close();
  }
  const fusion = new PhilipsFusionApi({ deviceType: 'airfryer', thingName: 'test' });
  fusion.state.properties.airfryer = { temp_unit: false };
  const calls = [];
  fusion.sendNcp = (...args) => { calls.push(args); };
  await fusion.setCookingSettings({ temperature: 180 });
  assert.equal(calls[0][2].temp_unit, false);
  fusion.close();
});

test('FUSION active heartbeat reads the cooking status port only', () => {
  const api = new PhilipsFusionApi({ deviceType: 'airfryer', thingName: 'test' });
  api.readPorts = ['Status', 'firmware_s', 'recipe_s'];
  api.publish = () => {};
  api.queuePortReads = (ports) => { api.queued = ports; };
  api.requestState({ activeOnly: true });
  assert.equal(api.queued.length, 1);
  assert.equal(api.queued[0], 'Status');
  api.close();
});

test('oversized HTTP responses are rejected before buffering them all', async() => {
  const original = http.request;
  http.request = (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.end = () => process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.destroy = (error) => response.emit('error', error);
      callback(response);
      response.emit('data', Buffer.alloc(1024));
    });
    return request;
  };
  const client = new HttpClient({ maxResponseBytes: 100 });
  try {
    await assert.rejects(client.request('http://example.invalid/test'), /memory safety limit/);
  } finally {
    http.request = original;
    client.close();
  }
});

test('FUSION basic recipe settings appear only with the advertised recipe port', async() => {
  const device = createDevice('espresso', 'EP8757', 'fusion');
  const writes = [];
  device.api = { connected: true, ritaProfiles: () => [], setBasicRecipeSetting: async(...args) => { writes.push(args); } };
  device.schedulePoll = () => {};
  await device.applyState({ powerOn: true, properties: { basicrecipe: { GrDose: 2, PrimDose: 40 } } });
  assert.equal(device.values.get('homeid_grinder_dose'), 2);
  assert.equal(device.values.get('homeid_primary_dose'), 40);
  assert.equal(device.capabilities.has('homeid_secondary_dose'), false);
  await device.listeners.get('homeid_grinder_dose')(3);
  assert.equal(writes[0][0], 'GrDose');
  assert.equal(writes[0][1], 3);
  const api = new PhilipsFusionApi({ deviceType: 'espresso', thingName: 'test' });
  api.sendNcp = (...args) => { api.lastNcp = args; };
  await assert.rejects(api.setBasicRecipeSetting('GrDose', 3), /does not support/);
  api.readPorts = ['command/BasicRecipe'];
  await api.setBasicRecipeSetting('GrDose', 3);
  assert.equal(api.lastNcp[0], 'basicrecipe');
  assert.equal(api.lastNcp[2].GrDose, 3);
  api.close();
});
