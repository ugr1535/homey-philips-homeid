'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PORTS, deviceTypeForModel, normalizeId, portForModel,
} = require('../lib/constants');

test('known product families resolve to the correct driver', () => {
  assert.equal(deviceTypeForModel('Philips HD9880 Venus2'), 'airfryer');
  assert.equal(deviceTypeForModel('NX0960 Nutrimax'), 'multicooker');
  assert.equal(deviceTypeForModel('AC0651'), 'air_purifier');
  assert.equal(deviceTypeForModel('EP8757 Rita'), 'espresso');
});

test('known models avoid unsafe multi-port probing', () => {
  assert.equal(portForModel('HD9280/90'), PORTS.AIRFRYER);
  assert.equal(portForModel('Philips HD9880'), PORTS.VENUS_2);
  assert.equal(portForModel('NX0950'), PORTS.HERMES);
});

test('device identifiers normalize MAC and UUID punctuation', () => {
  assert.equal(normalizeId('E4:BC:96-00.00.01'), 'e4bc96000001');
});
