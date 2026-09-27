'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');
const PhilipsFusionApi = require('../lib/fusion-api');

function createDevice(connection, capabilities) {
  const filename = path.join(__dirname, '..', 'lib', 'base-device.js');
  const source = fs.readFileSync(filename, 'utf8');
  const realRequire = createRequire(filename);
  const moduleContext = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleContext,
    exports: moduleContext.exports,
    require: (name) => (name === 'homey' ? { Device: class {} } : realRequire(name)),
  }, { filename });
  const DeviceClass = moduleContext.exports;
  const device = new DeviceClass();
  device.deviceType = 'espresso';
  device.getStoreValue = (key) => (key === 'connection' ? connection : undefined);
  device.values = new Map();
  device.settings = new Map();
  device.getSetting = (key) => device.settings.get(key);
  device.setSettings = async(settings) => {
    for (const [key, value] of Object.entries(settings)) device.settings.set(key, value);
  };
  device.capabilities = new Set(capabilities);
  device.hasCapability = (key) => device.capabilities.has(key);
  device.getCapabilityValue = (key) => device.values.get(key);
  device.setCapabilityValue = async(key, value) => { device.values.set(key, value); };
  device.addCapability = async(key) => { device.capabilities.add(key); };
  device.removeCapability = async(key) => { device.capabilities.delete(key); };
  device.setAvailable = async() => {};
  device.getAvailable = () => true;
  device.getName = () => 'Test Café Aromis';
  return device;
}

test('espresso widget names only a Homey-initiated brew and never guesses an external drink', async() => {
  const device = createDevice('fusion', ['homeid_machine_state', 'homeid_machine_status']);
  device.api = { ritaDrinks: () => ({ 14: 'Cappuccino' }), brewBuiltin: async() => true };
  device.schedulePoll = () => {};
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 0 } } });
  await device.brewBuiltin(14, 0);
  assert.equal(device.getWidgetStatus().drinkName, null);
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1 } } });
  assert.equal(device.getWidgetStatus().drinkName, 'Cappuccino');
  assert.equal(device.getWidgetStatus().drinkId, 14);
  assert.equal(device.getWidgetStatus().drinkSource, 'homey_request');
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 0 } } });
  assert.equal(device.getWidgetStatus().drinkName, null);
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1 } } });
  assert.equal(device.getWidgetStatus().state, 'brewing');
  assert.equal(device.getWidgetStatus().drinkName, null);
});

test('espresso widget retains the Homey drink when brewing state arrives during the command', async() => {
  const device = createDevice('fusion', ['homeid_machine_state']);
  device.schedulePoll = () => {};
  device.api = {
    lastBrewSessionId: null,
    ritaDrinks: () => ({ 14: 'Cappuccino' }),
    brewBuiltin: async() => {
      device.api.lastBrewSessionId = 41;
      await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1, SesOwnId: 41 } } });
      return true;
    },
  };
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 0, SesOwnId: 20 } } });
  await device.brewBuiltin(14, 0);
  assert.equal(device.getWidgetStatus().drinkName, 'Cappuccino');
  assert.equal(device.getWidgetStatus().drinkSource, 'homey_request');
});

test('espresso widget exposes cached maintenance percentages without inventing missing values', () => {
  const device = createDevice('fusion', [
    'homeid_machine_state', 'homeid_aquaclean_autonomy', 'homeid_descale_autonomy',
    'homeid_coffee_autonomy', 'homeid_brew_group_autonomy',
  ]);
  device.values.set('homeid_aquaclean_autonomy', 100);
  device.values.set('homeid_descale_autonomy', 0);
  device.values.set('homeid_coffee_autonomy', 94);
  assert.deepEqual({ ...device.getWidgetStatus().maintenance }, {
    aquaclean: 100, descale: 0, coffee: 94, brewGroup: null,
  });
  device.capabilities.delete('homeid_descale_autonomy');
  assert.equal(device.getWidgetStatus().maintenance.descale, null);
});

test('espresso widget rejects a brew session that belongs to another controller', async() => {
  const device = createDevice('fusion', ['homeid_machine_state']);
  device.api = { ritaDrinks: () => ({ 2: 'Espresso' }), brewBuiltin: async() => true, lastBrewSessionId: 41 };
  device.schedulePoll = () => {};
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 0 } } });
  await device.brewBuiltin(2, 0);
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1, SesOwnId: 42 } } });
  assert.equal(device.getWidgetStatus().drinkName, null);
});

test('espresso widget waits for a fresh session when status still contains the previous one', async() => {
  const device = createDevice('fusion', ['homeid_machine_state']);
  device.api = { ritaDrinks: () => ({ 2: 'Espresso' }), brewBuiltin: async() => true, lastBrewSessionId: 41 };
  device.schedulePoll = () => {};
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 0, SesOwnId: 20 } } });
  await device.brewBuiltin(2, 0);
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1, SesOwnId: 20 } } });
  assert.equal(device.getWidgetStatus().drinkName, null);
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1, SesOwnId: 41 } } });
  assert.equal(device.getWidgetStatus().drinkName, 'Espresso');
});

test('espresso widget API reads only an espresso device', async() => {
  const widget = require('../widgets/espresso-now/api');
  const powerCommands = [];
  const espresso = {
    getId: () => 'espresso-1',
    getWidgetStatus: () => ({ state: 'ready' }),
    getWidgetBrewMenu: () => ({ supported: true, profiles: [] }),
    setWidgetPower: async(enabled) => { powerCommands.push(enabled); },
    brewSavedFromWidget: async(profile, recipe) => {
      assert.equal(profile, 1);
      assert.equal(recipe, 2);
      return true;
    },
  };
  const homey = {
    drivers: {
      getDriver: (id) => {
        assert.equal(id, 'espresso');
        return { getDevices: () => [espresso] };
      },
    },
  };
  assert.deepEqual(await widget.getStatus({ homey, params: { deviceId: 'espresso-1' } }), { state: 'ready' });
  assert.deepEqual(await widget.getBrewMenu({ homey, params: { deviceId: 'espresso-1' } }), { supported: true, profiles: [] });
  assert.deepEqual(await widget.setPower({ homey, params: { deviceId: 'espresso-1' }, body: { enabled: true } }), { sent: true });
  assert.deepEqual(powerCommands, [true]);
  await assert.rejects(widget.setPower({ homey, params: { deviceId: 'espresso-1' }, body: { enabled: 'true' } }), /valid power state/);
  assert.deepEqual(await widget.brewSaved({ homey, params: { deviceId: 'espresso-1' }, body: { profileSlot: 1, recipeSlot: 2 } }), { sent: true });
  await assert.rejects(widget.brewSaved({ homey, params: { deviceId: 'espresso-1' }, body: { profileSlot: null, recipeSlot: 2 } }), /valid profile/);
  await assert.rejects(widget.getStatus({ homey, params: { deviceId: 'other' } }), /not found/);
  await assert.rejects(widget.getBrewMenu({ homey, params: { deviceId: 'other' } }), /not found/);
  await assert.rejects(widget.setPower({ homey, params: { deviceId: 'other' }, body: { enabled: false } }), /not found/);
  await assert.rejects(widget.brewSaved({ homey, params: { deviceId: 'other' }, body: { profileSlot: 1, recipeSlot: 2 } }), /not found/);
});

test('espresso widget power uses the existing command and blocks unavailable or brewing machines', async() => {
  const device = createDevice('fusion', ['onoff', 'homeid_machine_state']);
  const commands = [];
  const polls = [];
  device.api = { connected: true, setPower: async(type, enabled) => { commands.push([type, enabled]); } };
  device.schedulePoll = (delay) => polls.push(delay);
  device.values.set('onoff', false);
  device.values.set('homeid_machine_state', 'not_used');
  assert.equal(device.getWidgetStatus().powerOn, false);
  assert.equal(device.getWidgetStatus().canControlPower, true);
  assert.equal(device.getWidgetStatus().canStartBrew, false);
  await device.setWidgetPower(true);
  assert.deepEqual(commands, [['espresso', true]]);
  assert.deepEqual(polls, [1500]);
  assert.equal(device.getWidgetStatus().powerOn, false, 'a sent command is not confirmed machine state');
  device.values.set('onoff', true);
  await device.setWidgetPower(false);
  assert.deepEqual(commands[1], ['espresso', false]);

  device.values.set('homeid_machine_state', 'brewing');
  assert.equal(device.getWidgetStatus().canControlPower, false);
  await assert.rejects(device.setWidgetPower(false), /unavailable/);
  device.values.set('homeid_machine_state', 'not_used');
  device.api.connected = false;
  await assert.rejects(device.setWidgetPower(false), /unavailable/);
  await assert.rejects(device.setWidgetPower('false'), /valid power state/);
  assert.equal(commands.length, 2);

  const local = createDevice('local', ['onoff', 'homeid_machine_state']);
  const localCommands = [];
  local.api = { setPower: async(type, enabled) => { localCommands.push([type, enabled]); } };
  local.schedulePoll = () => {};
  local.values.set('onoff', false);
  local.values.set('homeid_machine_state', 'off');
  assert.equal(local.getWidgetStatus().canControlPower, true);
  await local.setWidgetPower(true);
  assert.deepEqual(localCommands, [['espresso', true]]);
});

test('espresso widget lists saved recipes by profile and sends one validated brew', async() => {
  const device = createDevice('fusion', ['onoff', 'homeid_machine_state']);
  const recipe = Buffer.from([0x08, 9, 0x10, 14]).toString('base64');
  const commands = [];
  device.schedulePoll = () => {};
  device.api = {
    connected: true,
    lastBrewSessionId: 41,
    ritaProfiles: () => [{ slot: 1, id: 9, name: 'Alice' }],
    ritaDrinks: () => ({ 14: 'Cappuccino' }),
    ritaSavedRecipes: (slot) => slot === 1 ? [{ slot: 8, name: 'Morning coffee', blob: recipe }] : [],
    brewSaved: async(profileSlot, recipeSlot) => { commands.push([profileSlot, recipeSlot]); return true; },
  };
  device.values.set('homeid_machine_state', 'not_used');
  device.values.set('onoff', true);
  assert.deepEqual(JSON.parse(JSON.stringify(device.getWidgetBrewMenu())), {
    supported: true,
    selectedProfile: 1,
    profiles: [{
      slot: 1,
      name: 'Alice',
      recipes: [{ slot: 0, name: 'Morning coffee', drinkId: 14, imageName: 'Cappuccino' }],
    }],
  });
  assert.equal(device.getWidgetStatus().canStartBrew, true);
  await assert.rejects(device.brewSavedFromWidget(1, 1), /no longer available/);
  assert.equal(commands.length, 0);
  await device.brewSavedFromWidget(1, 0);
  assert.deepEqual(commands, [[1, 8]]);
  await assert.rejects(device.brewSavedFromWidget(1, 0), /already sent/);
  await device.applyState({ powerOn: true, properties: { airfryer: { McState: 1, SesOwnId: 41 } } });
  assert.equal(device.getWidgetStatus().drinkName, 'Morning coffee');
  assert.equal(device.getWidgetStatus().drinkImageName, 'Cappuccino');
  assert.equal(commands.length, 1);
  device.values.set('homeid_machine_state', 'brewing');
  await assert.rejects(device.brewSavedFromWidget(1, 0), /not ready/);
  device.values.set('homeid_machine_state', 'not_used');
  device.values.set('onoff', false);
  await assert.rejects(device.brewSavedFromWidget(1, 0), /not ready/);
});

test('local espresso does not offer Rita saved recipes in the widget', () => {
  const device = createDevice('local', ['homeid_machine_state']);
  assert.equal(device.getWidgetBrewMenu().supported, false);
  assert.equal(device.getWidgetStatus().savedRecipeControl, false);
});

test('existing cloud espresso migrates to Rita measurements without re-pairing', async() => {
  const device = createDevice('fusion', [
    'onoff', 'homeid_machine_state', 'homeid_brew_progress',
    'homeid_water_level', 'homeid_bean_level', 'homeid_firmware',
  ]);
  await device.syncEspressoCapabilities();
  assert.equal(device.hasCapability('homeid_brew_progress'), false);
  assert.equal(device.hasCapability('homeid_water_level'), false);
  assert.equal(device.hasCapability('homeid_bean_level'), false);
  assert.equal(device.hasCapability('homeid_machine_status'), true);
  assert.equal(device.hasCapability('homeid_aquaclean_autonomy'), true);
  assert.equal(device.hasCapability('onoff'), true);

  await device.applyState({
    powerOn: true,
    properties: {
      airfryer: {
        McState: 1, McStatus: 1, McExInfo: 2, CtrlStatus: 2,
        BeanType: 0, RoastLevel: 2, AqFiltNum: 3,
        AqAutmy: 72, DescAutmy: 81, CorAutmy: 64, MbcAutmy: 43,
      },
      machinestatus: { mainstate: 0 },
      ncpFirmwareVersion: '2.1.0',
    },
  });
  assert.equal(device.values.get('onoff'), true);
  assert.equal(device.values.get('homeid_machine_state'), 'brewing');
  assert.equal(device.values.get('homeid_machine_status'), 'running');
  assert.equal(device.values.get('homeid_machine_alert'), 'water_lack');
  assert.equal(device.values.get('homeid_control_status'), 'no_error');
  assert.equal(device.values.get('homeid_bean_type'), 'arabica');
  assert.equal(device.values.get('homeid_roast_level'), 'dark');
  assert.equal(device.values.get('homeid_aquaclean_filter_number'), 3);
  assert.equal(device.values.get('homeid_aquaclean_autonomy'), 72);
  assert.equal(device.values.get('homeid_descale_autonomy'), 81);
  assert.equal(device.values.get('homeid_coffee_autonomy'), 64);
  assert.equal(device.values.get('homeid_brew_group_autonomy'), 43);
  assert.equal(device.values.get('homeid_firmware'), '2.1.0');
  assert.equal(device.getSetting('firmware'), '2.1.0');
});

test('local espresso retains progress and level capabilities', async() => {
  const device = createDevice('local', ['onoff', 'homeid_machine_state']);
  await device.syncEspressoCapabilities();
  await device.applyState({
    powerOn: true,
    properties: { machinestatus: { mainstate: 3, Progress: 35, waterlevel: 60, beanlevel: 70 } },
  });
  assert.equal(device.values.get('homeid_machine_state'), 'brewing');
  assert.equal(device.values.get('homeid_brew_progress'), 35);
  assert.equal(device.values.get('homeid_water_level'), 60);
  assert.equal(device.values.get('homeid_bean_level'), 70);
  assert.equal(device.hasCapability('homeid_machine_status'), false);
});

test('cloud espresso does not retain the old off state while status is missing', async() => {
  const device = createDevice('fusion', ['onoff', 'homeid_machine_state']);
  device.values.set('homeid_machine_state', 'off');
  await device.applyState({ powerOn: true, properties: {} });
  assert.equal(device.values.get('homeid_machine_state'), 'unknown');
});

test('existing cloud espresso gains profile and recipe controls with machine labels', async() => {
  const device = createDevice('fusion', ['onoff', 'homeid_machine_state']);
  await device.syncEspressoCapabilities();
  const profile = Buffer.from([0x08, 42, 0x22, 1, 9]).toString('base64');
  const recipe = Buffer.from([0x08, 9, 0x10, 14]).toString('base64');
  const names = Array(40).fill('');
  names[8] = 'Morning coffee';
  device.api = new PhilipsFusionApi({ deviceType: 'espresso', thingName: 'test-thing' });
  device.api.state.properties = {
    Profiles: { profile1: profile, Pr_Names: ',Alice' },
    Recipes_p1: { rcp8: recipe, Rec_Names: names.join(',') },
  };
  const options = new Map();
  device.setCapabilityOptions = async(capability, value) => { options.set(capability, value); };
  await device.updateRitaMenus();
  assert.equal(device.values.get('homeid_brew_profile'), '1');
  assert.equal(device.values.get('homeid_saved_recipe'), '0');
  assert.equal(options.get('homeid_brew_profile').values[0].title.en, 'Alice');
  assert.equal(options.get('homeid_saved_recipe').values[0].title.en, 'Morning coffee');
  assert.equal(device.hasCapability('homeid_brew_builtin'), true);
  assert.equal(device.hasCapability('homeid_abort_brew'), true);
});

test('Rita machine status does not override cloud shadow power', () => {
  const api = new PhilipsFusionApi({ deviceType: 'espresso', thingName: 'test-thing' });
  api.handleShadow({ state: { reported: { powerOn: true } } });
  api.handleNcp({
    cn: 'push', status: 0,
    data: { portName: 'machinestatus', properties: { mainstate: 0 } },
  });
  api.handleNcp({
    cn: 'push', status: 0,
    data: { portName: 'Status', properties: { McState: 1, AqAutmy: 70 } },
  });
  assert.equal(api.getFullState().powerOn, true);
  assert.equal(api.getFullState().properties.airfryer.McState, 1);
});

test('espresso custom capabilities reference shipped icons', () => {
  const driver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'drivers', 'espresso', 'driver.compose.json')));
  for (const capability of driver.capabilities.filter((id) => id.startsWith('homeid_'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.homeycompose', 'capabilities', `${capability}.json`)));
    assert.ok(manifest.icon, `${capability} needs an icon`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', manifest.icon)), `${capability} icon is missing`);
  }
});

test('espresso brew buttons have distinct icons', () => {
  const buttons = [
    'homeid_brew_builtin', 'homeid_brew_saved', 'homeid_brew_hot_water',
    'homeid_abort_brew', 'homeid_resume_brew', 'homeid_skip_step',
  ];
  const icons = buttons.map((id) => {
    const file = path.join(__dirname, '..', '.homeycompose', 'capabilities', `${id}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')).icon;
  });
  assert.equal(new Set(icons).size, buttons.length);
});
