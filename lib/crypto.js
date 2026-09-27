'use strict';

const crypto = require('crypto');

function decodeAesKey(hexKey) {
  let key = Buffer.from(String(hexKey).trim(), 'hex');
  if (key.length === 17 && key[0] === 0) key = key.subarray(1);
  if (key.length !== 16) throw new Error(`Invalid AES key length: ${key.length}`);
  return key;
}

function encryptPayload(value, hexKey) {
  const cipher = crypto.createCipheriv('aes-128-cbc', decodeAesKey(hexKey), Buffer.alloc(16));
  return Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]).toString('base64');
}

function decryptPayload(value, hexKey) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', decodeAesKey(hexKey), Buffer.alloc(16));
  return Buffer.concat([
    decipher.update(Buffer.from(String(value).trim(), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function createCondorAuthorization(challengeHeader, clientId, clientSecret) {
  const schemes = ['PhilipsCondor', 'PHILIPS-Condor', 'Philips-Condor'];
  let challenge = String(challengeHeader || '').trim();
  const scheme = schemes.find((candidate) => challenge.toLowerCase().startsWith(candidate.toLowerCase()))
    || 'PhilipsCondor';
  if (challenge.toLowerCase().startsWith(scheme.toLowerCase())) {
    challenge = challenge.slice(scheme.length).trim();
  }
  const challengeBytes = Buffer.from(challenge, 'base64');
  if (challengeBytes.length < 8 || challengeBytes.length > 64) {
    throw new Error(`Invalid Condor challenge length: ${challengeBytes.length}`);
  }
  const clientIdBytes = Buffer.from(clientId, 'base64');
  const secretBytes = Buffer.from(clientSecret, 'base64');
  const digest = crypto.createHash('sha256')
    .update(Buffer.concat([challengeBytes, clientIdBytes, secretBytes]))
    .digest();
  return `${scheme} ${Buffer.concat([clientIdBytes, digest]).toString('base64')}`;
}

module.exports = {
  createCondorAuthorization,
  decryptPayload,
  encryptPayload,
};
