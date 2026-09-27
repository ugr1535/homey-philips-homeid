'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PhilipsCloudApi } = require('../lib/cloud-api');

test('HomeID tenant discovery identifies itself as a JSON client', async() => {
  const api = new PhilipsCloudApi();
  let request;
  try {
    api.client.json = async(url, options) => {
      request = { url, options };
      return { status: 200, data: {} };
    };

    const appliances = await api.getHomeIdAppliances({ access_token: 'access' });

    assert.deepEqual(appliances, []);
    assert.match(request.url, /\/\.well-known\/tenant\/oneka$/);
    assert.equal(request.options.headers.Accept, 'application/json');
    assert.equal(request.options.headers['User-Agent'], 'Homey Philips HomeID');
  } finally {
    api.close();
  }
});

test('HomeID appliances with Condor credentials become local devices', () => {
  const api = new PhilipsCloudApi();
  try {
    const devices = api.mergeCloudDevices([
      {
        name: 'Kitchen Airfryer',
        modelNumber: 'HD9280',
        macAddress: 'E4:BC:96:00:00:01',
        clientId: 'client',
        clientSecret: 'secret',
      },
    ], [], { refresh_token: 'refresh' }, 'homeid');
    assert.equal(devices.length, 1);
    assert.equal(devices[0].connection, 'local');
    assert.equal(devices[0].id, 'e4bc96000001');
    assert.equal(devices[0].clientSecret, 'secret');
  } finally {
    api.close();
  }
});

test('HomeID appliances without local credentials use matched FUSION thing', () => {
  const api = new PhilipsCloudApi();
  try {
    const devices = api.mergeCloudDevices([
      {
        name: 'Living Air',
        modelNumber: 'AC0651',
        macAddress: 'AA:BB:CC:DD:EE:FF',
        externalDeviceId: 'device-123',
      },
    ], [
      { id: 'device-123', thingName: 'da-real-thing', ctn: 'AC0651' },
    ], { refresh_token: 'refresh' }, 'homeid');
    assert.equal(devices.length, 1);
    assert.equal(devices[0].connection, 'fusion');
    assert.equal(devices[0].thingName, 'da-real-thing');
    assert.equal(devices[0].refreshToken, 'refresh');
  } finally {
    api.close();
  }
});

test('FUSION-capable local records retain a cloud fallback', () => {
  const api = new PhilipsCloudApi();
  try {
    const [device] = api.mergeCloudDevices([
      {
        name: 'Airfryer',
        modelNumber: 'HD9880',
        macAddress: 'AA:BB:CC:DD:EE:01',
        externalDeviceId: 'device-9880',
        clientId: 'local-client',
        clientSecret: 'local-secret',
      },
    ], [
      { id: 'device-9880', thingName: 'da-hd9880', ctn: 'HD9880' },
    ], { refresh_token: 'refresh' }, 'homeid');
    assert.equal(device.connection, 'local');
    assert.equal(device.fusionFallback.connection, 'fusion');
    assert.equal(device.fusionFallback.thingName, 'da-hd9880');
  } finally {
    api.close();
  }
});

test('cloud discovery skips the unrelated Air+ login for non-purifier drivers', async() => {
  const api = new PhilipsCloudApi();
  const oauthClients = [];
  try {
    api.getOidcTokens = async(sessionToken, client) => {
      oauthClients.push(client);
      return { access_token: 'access', refresh_token: 'refresh' };
    };
    api.getHomeIdAppliances = async() => [];
    api.getDevices = async() => [];

    const devices = await api.discover('session', { includeAirPlus: false });

    assert.deepEqual(devices, []);
    assert.deepEqual(oauthClients, ['homeid']);
  } finally {
    api.close();
  }
});

test('HomeID appliance and registry lookups start in parallel', async() => {
  const api = new PhilipsCloudApi();
  let applianceStarted = false;
  let registryStarted = false;
  try {
    api.getOidcTokens = async() => ({ access_token: 'access', refresh_token: 'refresh' });
    api.getHomeIdAppliances = async() => {
      applianceStarted = true;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(registryStarted, true);
      return [];
    };
    api.getDevices = async() => {
      registryStarted = true;
      assert.equal(applianceStarted, true);
      return [];
    };

    await api.discover('session', { includeAirPlus: false });
  } finally {
    api.close();
  }
});
