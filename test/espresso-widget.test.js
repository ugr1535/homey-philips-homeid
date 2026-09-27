'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DRINKS } = require('../lib/rita');

const root = path.join(__dirname, '..');
const widget = path.join(root, 'widgets', 'espresso-now');

test('espresso widget ships a valid preview, a device filter and every local drink illustration', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(widget, 'widget.compose.json'), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose', 'app.json'), 'utf8'));
  assert.equal(manifest.devices.singular, true);
  assert.equal(manifest.devices.filter.capabilities, 'homeid_machine_state');
  assert.equal(manifest.api.getStatus.method, 'GET');
  assert.equal(manifest.api.getBrewMenu.method, 'GET');
  assert.equal(manifest.api.setPower.method, 'POST');
  assert.equal(manifest.api.setPower.path, '/power/:deviceId');
  assert.equal(manifest.api.brewSaved.method, 'POST');
  assert.equal(manifest.height, 320);
  assert.equal(app.compatibility, '>=12.3.0');
  for (const mode of ['dark', 'light']) {
    const preview = fs.readFileSync(path.join(widget, `preview-${mode}.png`));
    assert.deepEqual([...preview.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(preview.readUInt32BE(16), preview.readUInt32BE(20), `${mode} preview must fit Homey's square tile`);
    const svg = fs.readFileSync(path.join(widget, `preview-${mode}.svg`), 'utf8');
    assert.doesNotMatch(svg, /Cappuccino|Café Aromis|Temsili görsel|<image\b/);
  }
  for (const name of ['generic', 'espresso', 'coffee', 'latte', 'cappuccino', 'iced', 'water']) {
    const image = fs.readFileSync(path.join(widget, 'public', 'images', `${name}.svg`), 'utf8');
    assert.match(image, /^<svg /);
  }
});

test('espresso widget browser script parses without external assets or user-supplied HTML', () => {
  const html = fs.readFileSync(path.join(widget, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /textContent/);
  assert.match(script, /Homey\.ready\(\)/);
  assert.doesNotMatch(script, /innerHTML|https?:\/\//);
  assert.doesNotMatch(html, /Temsili görsel|Illustrative image|image-note/);
  assert.match(html, /renderMaintenance\(status\.maintenance\)/);
  assert.match(script, /homey\.api\('POST', `\/brew-saved\/\$\{encodeURIComponent\(deviceId\)\}`/);
});

test('espresso widget follows Homey language instead of phone browser language', () => {
  const html = fs.readFileSync(path.join(widget, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const locales = Object.fromEntries(['de', 'en'].map((language) => [language,
    JSON.parse(fs.readFileSync(path.join(root, 'locales', `${language}.json`), 'utf8')).widget.espressoNow]));

  for (const language of ['de', 'en', 'missing']) {
    const expected = locales[language] || locales.en;
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          classList: { toggle() {} }, addEventListener() {}, setAttribute() {},
        });
      }
      return elements.get(id);
    };
    const documentElement = { lang: '', dir: '' };
    const document = { getElementById: element, documentElement, addEventListener() {} };
    const onHomeyReady = vm.runInNewContext(`${script}\nonHomeyReady`, {
      document,
      navigator: { language: 'tr-TR' },
      window: { location: { search: '' }, setInterval: () => 1, addEventListener() {} },
      URLSearchParams,
    });
    onHomeyReady({
      getDeviceIds: () => [], ready() {},
      __(key) { return locales[language]?.[key.split('.').at(-1)] || key; },
    });
    assert.equal(element('heading').textContent, expected.heading);
    assert.equal(element('name').textContent, expected.choose);
    assert.equal(documentElement.lang, expected.language);
    assert.equal(document.title, expected.heading);
  }
});

test('espresso widget sends a power command once and never starts a brew from the power button', async() => {
  const html = fs.readFileSync(path.join(widget, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        disabled: false, hidden: false, value: '', style: {},
        classList: { toggle() {} }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
      });
    }
    return elements.get(id);
  };
  const controls = vm.runInNewContext(`${script}\n({
    togglePower, openBrewPanel, render, hasPendingPower: () => Boolean(powerPending),
    setContext: (api, status) => {
      homey = api; deviceId = 'espresso-1'; lastStatus = status;
      powerPending = null; powerSending = false;
    }
  })`, {
    document: { getElementById: element },
    navigator: { language: 'tr-TR' },
    window: { location: { search: '' }, setTimeout: () => 1, clearTimeout() {} },
    URLSearchParams,
  });
  const calls = [];
  const api = { api: async(method, route, body) => { calls.push({ method, route, body }); return { sent: true }; } };
  controls.setContext(api, { powerOn: false, canControlPower: true, canStartBrew: false });
  await controls.togglePower();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    method: 'POST', route: '/power/espresso-1', body: { enabled: true },
  }]);
  assert.equal(element('power').disabled, true);
  await controls.togglePower();
  assert.equal(calls.length, 1, 'do not duplicate a pending command');
  controls.render({
    deviceName: 'Café Aromis', available: true, state: 'not_used', powerOn: true,
    canControlPower: true, canStartBrew: true, savedRecipeControl: true, maintenance: null, progress: null,
  });
  assert.equal(controls.hasPendingPower(), false, 'confirmed state clears the pending command');
  assert.equal(element('power').disabled, false);

  await controls.togglePower();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
    method: 'POST', route: '/power/espresso-1', body: { enabled: false },
  });
  controls.setContext(api, { powerOn: true, canControlPower: false, canStartBrew: false });
  await controls.togglePower();
  assert.equal(calls.length, 2, 'offline or busy machines cannot be toggled');
  controls.render({
    available: true, state: 'not_used', powerOn: false, canControlPower: true,
    canStartBrew: false, savedRecipeControl: true, maintenance: null, progress: null,
  });
  assert.equal(element('badge').textContent, 'Kapalı', 'off power must not appear ready');
  assert.equal(element('open-brew').disabled, true);
  await controls.openBrewPanel();
  assert.equal(calls.length, 2, 'the recipe menu must wait until power-on is confirmed');
});

test('espresso widget renders only reported maintenance and highlights low values', () => {
  const html = fs.readFileSync(path.join(widget, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: false,
        style: {},
        classList: {
          values: new Set(),
          toggle(name, active) {
            if (active) { this.values.add(name); } else { this.values.delete(name); }
          },
        },
      });
    }
    return elements.get(id);
  };
  const renderMaintenance = vm.runInNewContext(`${script}\nrenderMaintenance`, {
    document: { getElementById: element },
    navigator: { language: 'tr-TR' },
    window: { location: { search: '' } },
    URLSearchParams,
  });
  renderMaintenance({ aquaclean: 100, descale: 0, coffee: null, brewGroup: 9 });
  assert.equal(element('maintenance').hidden, false);
  assert.equal(element('value-aquaclean').textContent, '100%');
  assert.equal(element('value-descale').textContent, '0%');
  assert.equal(element('fill-descale').style.width, '0%');
  assert.equal(element('metric-coffee').hidden, true);
  assert.equal(element('metric-brewGroup').classList.values.has('critical'), true);
  renderMaintenance(null);
  assert.equal(element('maintenance').hidden, true);
});

test('espresso widget selects a profile recipe and sends only one brew request', async() => {
  const html = fs.readFileSync(path.join(widget, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        hidden: false, disabled: false, value: '', style: {}, children: [],
        classList: { toggle() {} },
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
        replaceChildren(...children) {
          this.children = children;
          this.value = children[0]?.value || '';
        },
      });
    }
    return elements.get(id);
  };
  const status = {
    deviceName: 'Test Café Aromis', available: true, state: 'not_used', alert: null,
    savedRecipeControl: true, canStartBrew: true, maintenance: null, progress: null,
  };
  const posts = [];
  const scheduledRefreshes = [];
  let rejectBrew = false;
  const Homey = {
    getDeviceIds: () => ['espresso-1'], ready() {},
    api: async(method, route, body) => {
      if (method === 'GET' && route.startsWith('/status/')) { return status; }
      if (method === 'GET' && route.startsWith('/brew-menu/')) {
        return {
          supported: true, selectedProfile: 1,
          profiles: [{
            slot: 1,
            name: 'Alice',
            recipes: [{ slot: 0, name: 'Morning coffee', drinkId: 14, imageName: 'Cappuccino' }],
          }],
        };
      }
      if (method === 'POST' && route.startsWith('/brew-saved/')) {
        if (rejectBrew) throw new Error('Machine rejected brew request');
        posts.push(body);
        return { sent: true };
      }
      throw new Error('Unexpected widget request');
    },
  };
  const widgetUi = vm.runInNewContext(`${script}\n({ onHomeyReady, openBrewPanel, startSavedBrew })`, {
    document: { getElementById: element, createElement: () => ({}), addEventListener() {}, visibilityState: 'visible' },
    navigator: { language: 'tr-TR' },
    window: {
      location: { search: '' }, setInterval: () => 1, clearInterval() {}, addEventListener() {},
      setTimeout(callback, delay) { scheduledRefreshes.push({ callback, delay }); return scheduledRefreshes.length; },
      clearTimeout() {},
    },
    URLSearchParams,
  });
  widgetUi.onHomeyReady(Homey);
  await new Promise((resolve) => setImmediate(resolve));
  await widgetUi.openBrewPanel();
  assert.equal(element('brew-panel').hidden, false);
  assert.equal(element('profile-select').value, '1');
  assert.equal(element('recipe-select').value, '0');
  assert.equal(element('start-brew').disabled, false);
  rejectBrew = true;
  await widgetUi.startSavedBrew();
  assert.equal(element('brew-panel').hidden, false, 'a failed request should leave the selection panel open');
  assert.equal(element('brew-feedback').textContent, 'Demleme isteği gönderilemedi.');
  rejectBrew = false;
  await widgetUi.startSavedBrew();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [{ profileSlot: 1, recipeSlot: 0 }]);
  assert.equal(element('brew-feedback').textContent, 'Demleme isteği gönderildi.');
  assert.equal(element('brew-panel').hidden, true, 'an accepted request should return to the main widget');
  assert.equal(element('name').textContent, 'Morning coffee', 'requested recipe is visible while status catches up');
  assert.equal(element('detail').textContent, 'Demleme isteği gönderildi.');
  assert.equal(element('source').hidden, false, 'the selected drink image is visible immediately');
  assert.match(element('source').style.backgroundImage, /menu-1811\.jpg/);
  assert.deepEqual(Array.from(scheduledRefreshes, ({ delay }) => delay), [2500, 6000]);
  await new Promise((resolve) => setImmediate(resolve));
  status.state = 'brewing';
  status.drinkName = 'Morning coffee';
  status.drinkImageName = 'Cappuccino';
  status.drinkId = 14;
  status.canStartBrew = false;
  await scheduledRefreshes[0].callback();
  assert.equal(element('name').textContent, 'Morning coffee', 'a follow-up poll should show confirmed brewing');
  assert.equal(element('source').hidden, false, 'confirmed brewing keeps the matching drink image');
  await widgetUi.startSavedBrew();
  assert.equal(posts.length, 1);
});

test('supplied HomeID menu screenshots map to the correct hot and cold drinks', () => {
  const html = fs.readFileSync(path.join(widget, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  const mapping = vm.runInNewContext(`${script}\n({ originalTile, normalizedDrink })`, {
    document: { getElementById: () => null },
    navigator: { language: 'tr-TR' },
    window: { location: { search: '' } },
    URLSearchParams,
  });
  for (const [id, name] of Object.entries({ ...DRINKS, 21: 'Hot water' })) {
    assert.ok(mapping.originalTile(name, id), `${id}: ${name}`);
  }
  for (const [name, sheet, row, column] of [
    ['Espresso', '1811', 0, 1],
    ['Cappuccino', '1811', 5, 0],
    ['Buzlu Latte', '1812', 5, 1],
    ['Buzlu Espresso Doppio', '1813', 0, 1],
    ['Buzlu Cortado', '1814', 0, 0],
    ['Cold Brew Latte', '1814', 4, 1],
    ['Cappuccino XL', '1814', 6, 1],
  ]) {
    const tile = mapping.originalTile(name);
    assert.equal(tile?.sheet, sheet, name);
    assert.equal(tile?.row, row, name);
    assert.equal(tile?.column, column, name);
  }
  for (const sheet of [1811, 1812, 1813, 1814]) {
    const file = fs.readFileSync(path.join(widget, 'public', 'images', 'philips', `menu-${sheet}.jpg`));
    assert.equal(file[0], 0xff);
    assert.equal(file[1], 0xd8);
    assert.ok(file.length > 100000);
  }
});
