'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

test('email request acknowledges and OTP verification returns a pairable EP8757', async() => {
  const filename = path.join(__dirname, '..', 'lib', 'base-driver.js');
  const source = fs.readFileSync(filename, 'utf8');
  const realRequire = createRequire(filename);
  const logs = [];
  const settingsValues = new Map();
  const moduleContext = { exports: {} };

  class FakeCloudApi {
    requestOtp() { return 'verification-token'; }

    verifyOtp() { return 'session-token'; }

    discover() {
      return [{
        id: 'aabbccddeeff',
        name: 'Philips EP8757',
        model: 'EP8757',
        connection: 'fusion',
        thingName: 'da-ep8757',
        deviceId: 'device-8757',
        refreshToken: 'test-refresh-token',
        oauthClient: 'homeid',
      }];
    }

    close() {}
  }

  const fakeRequire = (request) => {
    if (request === 'homey') return { Driver: class {} };
    if (request === './cloud-api') return { PhilipsCloudApi: FakeCloudApi, CloudConnectionError: class extends Error {} };
    return realRequire(request);
  };
  vm.runInNewContext(source, {
    module: moduleContext,
    exports: moduleContext.exports,
    require: fakeRequire,
    URL,
  }, { filename });

  const DriverClass = moduleContext.exports;
  const driver = new DriverClass();
  driver.id = 'espresso';
  driver.log = (message) => logs.push(message);
  driver.homey = {
    settings: {
      get: (key) => settingsValues.get(key),
      set: (key, value) => settingsValues.set(key, value),
    },
  };
  const handlers = new Map();
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });

  const requested = await handlers.get('send_otp')({ email: 'owner@example.test' });
  const devices = await handlers.get('verify_otp')({ code: '123456' });

  assert.equal(requested, true);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Philips EP8757');
  assert.equal(devices[0].data.id, 'aabbccddeeff');
  assert.equal(devices[0].store.connection, 'fusion');
  assert.equal(devices[0].icon, '/icon.svg');
  assert.ok(devices[0].capabilities.includes('homeid_machine_status'));
  assert.ok(devices[0].capabilities.includes('homeid_aquaclean_autonomy'));
  assert.equal(devices[0].capabilities.includes('homeid_water_level'), false);
  assert.equal(devices[0].store.refreshToken, 'test-refresh-token');
  assert.equal(logs.some((line) => line.includes('test-refresh-token')), false);
  const diagnostics = settingsValues.get('pairingDiagnostics');
  assert.deepEqual(Array.from(diagnostics, (entry) => entry.stage), [
    'pair_open', 'send_otp_start', 'send_otp_ok', 'verify_start', 'verify_ok',
    'discover_ok', 'matched', 'verify_return',
  ]);
  assert.equal(diagnostics.find((entry) => entry.stage === 'matched').count, 1);
  await handlers.get('pair_progress')({ stage: 'ui_create_start', code: '123456' });
  await handlers.get('pair_progress')({ stage: 'not_allowed', secret: 'test-refresh-token' });
  assert.equal(settingsValues.get('pairingDiagnostics').at(-1).stage, 'ui_create_start');
  assert.equal(JSON.stringify(settingsValues.get('pairingDiagnostics')).includes('test-refresh-token'), false);
  assert.equal(JSON.stringify(settingsValues.get('pairingDiagnostics')).includes('123456'), false);

  const restartedDriver = new DriverClass();
  restartedDriver.id = 'espresso';
  restartedDriver.homey = driver.homey;
  restartedDriver.log = driver.log;
  const restartedHandlers = new Map();
  await restartedDriver.onPair({ setHandler: (name, handler) => restartedHandlers.set(name, handler) });
  await assert.rejects(restartedHandlers.get('verify_otp')({ code: '123456' }), /Request a verification code first/);
  assert.equal(settingsValues.get('pairingDiagnostics').at(-1).stage, 'verify_missing_state');
  assert.equal(await restartedHandlers.get('pincode')(['1', '2', '3']), false);
  await restartedHandlers.get('send_otp')({ email: 'owner@example.test' });
  assert.equal(await restartedHandlers.get('pincode')(['1', '2', '3', '4', '5', '6']), true);
  assert.equal((await restartedHandlers.get('get_verified_devices')()).length, 1);
});

test('native PIN accepts a valid code before discovery and shows missing devices on the next view', async() => {
  const filename = path.join(__dirname, '..', 'lib', 'base-driver.js');
  const source = fs.readFileSync(filename, 'utf8');
  const realRequire = createRequire(filename);
  const moduleContext = { exports: {} };
  class FakeCloudApi {
    requestOtp() { return 'verification-token'; }

    verifyOtp(email, code) {
      if (code !== '123456') throw new Error('Invalid verification code');
      return 'session-token';
    }

    discover() { return []; }

    close() {}
  }
  vm.runInNewContext(source, {
    module: moduleContext,
    exports: moduleContext.exports,
    require: (request) => {
      if (request === 'homey') return { Driver: class {} };
      if (request === './cloud-api') return { PhilipsCloudApi: FakeCloudApi, CloudConnectionError: class extends Error {} };
      return realRequire(request);
    },
    URL,
  }, { filename });
  const DriverClass = moduleContext.exports;
  const driver = new DriverClass();
  driver.id = 'espresso';
  driver.log = () => {};
  driver.homey = { settings: { get: () => [], set: () => {} } };
  const handlers = new Map();
  await driver.onPair({ setHandler: (name, handler) => handlers.set(name, handler) });
  await handlers.get('send_otp')({ email: 'owner@example.test' });
  assert.equal(await handlers.get('pincode')(['0', '0', '0', '0', '0', '0']), false);
  assert.equal(await handlers.get('pincode')(['1', '2', '3', '4', '5', '6']), true);
  await assert.rejects(handlers.get('get_verified_devices')(), /No compatible cloud device was found/);
});

test('native PIN flow selects and creates the verified appliance before closing', async() => {
  const filename = path.join(__dirname, '..', 'drivers', 'espresso', 'pair', 'cloud_select_v1.html');
  const html = fs.readFileSync(filename, 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const loginFilename = path.join(__dirname, '..', 'drivers', 'espresso', 'pair', 'cloud_login_v5.html');
  const loginScript = fs.readFileSync(loginFilename, 'utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(loginScript);

  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        value: '',
        style: {},
        events: {},
        addEventListener(event, handler) { this.events[event] = handler; },
      });
    }
    return nodes.get(id);
  };
  const calls = [];
  const device = { name: 'Philips EP8757', data: { id: 'aabbccddeeff' } };
  const document = { getElementById: element };
  const Homey = {
    __: (key) => key,
    ready: () => undefined,
    emit: async(event, data) => {
      calls.push(event === 'pair_progress' ? data.stage : event);
      return event === 'get_verified_devices' ? [device] : true;
    },
    createDevice: async(value) => {
      calls.push('createDevice');
      assert.equal(value, device);
    },
    done: () => calls.push('done'),
  };

  vm.runInNewContext(`${loginScript}\n${script}`, { document, Homey, Error, Array, setTimeout });
  assert.equal(element('submit').textContent, 'Send verification code');
  assert.equal(element('selection-add').textContent, 'Add appliance');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    'get_verified_devices', 'ui_received_devices',
    'ui_create_start', 'createDevice', 'ui_create_ok', 'ui_done', 'done',
  ]);
});
