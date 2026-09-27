'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const PhilipsLocalApi = require('../lib/local-api');

test('Venus status fields are normalized to common Homey fields', () => {
  const api = new PhilipsLocalApi({ host: '127.0.0.1', model: 'HD9880' });
  try {
    const normalized = api.normalizeVenus({
      disp_time: 60,
      total_time: 600,
      method: 3,
      current_temp: 180,
      drw_opn: true,
    });
    assert.equal(normalized.cur_time, 60);
    assert.equal(normalized.time, 600);
    assert.equal(normalized.preset, 3);
    assert.equal(normalized.cur_temp, 180);
    assert.equal(normalized.drawer_open, true);
  } finally {
    api.close();
  }
});

test('Venus cooking start uses precook, settings and cooking sequence', async() => {
  const api = new PhilipsLocalApi({ host: '127.0.0.1', model: 'HD9880' });
  const calls = [];
  api.request = async(port, options) => {
    calls.push({ port, ...options });
    return {};
  };
  try {
    await api.startCooking({ temperature: 190, durationSeconds: 900 });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].data.status, 'precook');
    assert.equal(calls[1].data.temp, 190);
    assert.equal(calls[1].data.total_time, 900);
    assert.equal(calls[2].data.status, 'cooking');
  } finally {
    api.close();
  }
});

test('SPECTRE stop returns the appliance to standby', async() => {
  const api = new PhilipsLocalApi({ host: '127.0.0.1', model: 'HD9280' });
  let command;
  api.request = async(port, options) => {
    command = { port, ...options };
    return {};
  };
  try {
    await api.stopCooking();
    assert.equal(command.port, 'airfryer');
    assert.deepEqual(command.data, { status: 'standby' });
  } finally {
    api.close();
  }
});

test('unverified local hot-water recipe is not sent', async() => {
  const api = new PhilipsLocalApi({ host: '127.0.0.1', model: 'EP2520' });
  api.request = async() => {
    throw new Error('must not be called');
  };
  try {
    await assert.rejects(api.brewDrink('hot_water', 120), /Unsupported drink/);
  } finally {
    api.close();
  }
});
