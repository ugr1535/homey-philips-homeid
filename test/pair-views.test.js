'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const drivers = ['espresso', 'airfryer', 'multicooker', 'air_purifier'];
const views = ['choose_method_v5', 'cloud_login_v5', 'cloud_select_v1', 'manual'];

for (const driver of drivers) {
  for (const view of views) {
    test(`${driver} ${view} is a self-contained Homey pairing view`, () => {
      const filename = path.join(__dirname, '..', 'drivers', driver, 'pair', `${view}.html`);
      const source = fs.readFileSync(filename, 'utf8');

      assert.match(source, /^<!DOCTYPE html>/);
      assert.match(source, /Homey\.ready\(\)/);
      assert.doesNotMatch(source, /onHomeyReady/);
      assert.doesNotMatch(source, /<script\s+src=/);
      assert.match(source, /function translate\(key, fallback\)/);
      assert.doesNotMatch(source, /textContent = Homey\.__\(/);
      if (view === 'cloud_select_v1') {
        assert.match(source, /await Homey\.emit\('get_verified_devices'/);
        assert.match(source, /await Homey\.createDevice\(device\)/);
        assert.match(source, /Homey\.done\(\)/);
        assert.match(source, /renderDevices\(devices\)/);
        assert.doesNotMatch(source, /Homey\.setViewStoreValue\(/);
        assert.doesNotMatch(source, /verify_otp|0\.1\.14/);
        assert.match(source, /button\.addEventListener\('click'/);
        assert.doesNotMatch(source, /<form/);
        assert.match(source, /\(function \(\) \{/);
        assert.match(source, /color: #fff !important/);
      }
    });
  }
}

for (const driver of drivers) {
  test(`${driver} selection controls do not reuse IDs from earlier pairing views`, () => {
    const pairDir = path.join(__dirname, '..', 'drivers', driver, 'pair');
    const idsIn = (view) => [...fs.readFileSync(path.join(pairDir, `${view}.html`), 'utf8').matchAll(/\bid="([^"]+)"/g)]
      .map((match) => match[1]);
    const earlier = new Set(['choose_method_v5', 'cloud_login_v5', 'manual'].flatMap(idsIn));
    for (const id of idsIn('cloud_select_v1')) assert.equal(earlier.has(id), false, `Duplicate pairing ID: ${id}`);
  });
}

test('every driver uses Homey PIN template followed by the appliance selection view', () => {
  for (const driver of drivers) {
    const filename = path.join(__dirname, '..', 'drivers', driver, 'driver.compose.json');
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const pin = manifest.pair.find((view) => view.id === 'pincode');
    assert.equal(pin.template, 'pincode');
    assert.equal(pin.options.type, 'number');
    assert.equal(pin.options.length, 6);
    assert.equal(pin.navigation.next, 'cloud_select_v1');
    assert.ok(manifest.pair.some((view) => view.id === 'cloud_select_v1'));
    assert.equal(manifest.pair.some((view) => view.id === 'cloud_otp_v8'), false);
    assert.equal(manifest.settings.find((setting) => setting.id === 'model').type, 'label');
    assert.equal(manifest.settings.find((setting) => setting.id === 'connection').type, 'label');
    assert.equal(manifest.settings.find((setting) => setting.id === 'firmware').type, 'label');
    assert.equal(manifest.capabilities.includes('homeid_firmware'), false);
  }
});

test('the pairing back-end retains the discovered cloud devices', () => {
  const filename = path.join(__dirname, '..', 'lib', 'base-driver.js');
  const source = fs.readFileSync(filename, 'utf8');

  assert.match(source, /return state\.devices;/);
  assert.match(source, /session\.setHandler\('get_verified_devices'/);
  assert.doesNotMatch(source, /session\.showView\(/);
});
