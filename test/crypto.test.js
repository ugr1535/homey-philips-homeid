'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  createCondorAuthorization,
  decryptPayload,
  encryptPayload,
} = require('../lib/crypto');

test('AES-CBC payloads round-trip with a zero IV', () => {
  const key = '00112233445566778899aabbccddeeff';
  const body = JSON.stringify({ status: 'cooking', temp: 180 });
  const encrypted = encryptPayload(body, key);
  assert.notEqual(encrypted, body);
  assert.equal(decryptPayload(encrypted, key), body);
});

test('17-byte Philips keys with a leading zero are accepted', () => {
  const key = '00aabbccddeeff00112233445566778899';
  const encrypted = encryptPayload('hello', key);
  assert.equal(decryptPayload(encrypted, key), 'hello');
});

test('Condor authorization contains client id and SHA-256 response', () => {
  const challenge = crypto.randomBytes(16);
  const clientId = crypto.randomBytes(12).toString('base64');
  const secret = crypto.randomBytes(24).toString('base64');
  const authorization = createCondorAuthorization(
    `PhilipsCondor ${challenge.toString('base64')}`,
    clientId,
    secret,
  );
  const encoded = authorization.split(' ')[1];
  const response = Buffer.from(encoded, 'base64');
  assert.deepEqual(response.subarray(0, 12), Buffer.from(clientId, 'base64'));
  assert.equal(response.length, 44);
});
