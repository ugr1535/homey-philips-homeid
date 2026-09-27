'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const PhilipsFusionApi = require('../lib/fusion-api');
const { PhilipsCloudApi } = require('../lib/cloud-api');
const { profileRecipeIds, profiles, savedRecipes } = require('../lib/rita');

const profileBlob = Buffer.from([0x08, 42, 0x22, 3, 7, 9, 7]).toString('base64');
const firstRecipe = Buffer.from([0x08, 9, 0x10, 2]).toString('base64');
const secondRecipe = Buffer.from([0x08, 7, 0x10, 14]).toString('base64');

function ritaProperties() {
  const names = Array(40).fill('');
  names[9] = 'My cappuccino';
  return {
    Profiles: { profile1: profileBlob, Pr_Names: ',Alice' },
    Recipes_p1: { rcp8: firstRecipe, rcp9: secondRecipe, Rec_Names: names.join(',') },
    airfryer: { SesOwnId: 12345, BeanType: 0, RoastLevel: 2 },
  };
}

function apiWithState() {
  const api = new PhilipsFusionApi({ deviceType: 'espresso', thingName: 'rita-test' });
  api.state.properties = ritaProperties();
  api.commands = [];
  api.sendNcp = (port, command, properties) => api.commands.push({ port, command, properties });
  return api;
}

test('Rita profiles and saved recipes use wire IDs, profile slots and machine order', () => {
  const properties = ritaProperties();
  assert.deepEqual(profileRecipeIds(profileBlob), [7, 9]);
  assert.deepEqual(profiles(properties), [{ slot: 1, id: 42, name: 'Alice' }]);
  const recipes = savedRecipes(properties, 1);
  assert.deepEqual(recipes.map(({ slot, name }) => [slot, name]), [
    [9, 'My cappuccino'], [8, 'Espresso'],
  ]);
  assert.deepEqual(savedRecipes(properties, 0), []);
});

test('malformed and empty Rita protobuf data is ignored safely', () => {
  assert.deepEqual(profileRecipeIds(Buffer.from([0x22, 5, 1]).toString('base64')), []);
  assert.deepEqual(profileRecipeIds('not base64'), []);
  assert.deepEqual(profiles({ Profiles: { profile0: 'bad!' } }), []);
});

test('Rita built-in and saved brews use the real profile ID and saved blob', async() => {
  const api = apiWithState();
  await api.brewBuiltin(1, 2);
  assert.equal(api.commands[0].properties.CtrlCmd, 1);
  assert.equal(api.commands[0].properties.Profile_id, 42);
  assert.equal(api.commands[0].properties.Recipe_id, 2);
  await api.brewSaved(1, 9);
  assert.equal(api.commands[1].properties.CtrlCmd, 2);
  assert.equal(api.commands[1].properties.Profile_id, 42);
  assert.equal(api.commands[1].properties.RcpBinData, secondRecipe);
  await assert.rejects(api.brewSaved(0, 9), /not available/);
  await assert.rejects(api.brewBuiltin(0, 2), /not available/);
  assert.equal(api.commands.length, 2);
});

test('Rita brew controls preserve the active session ID', async() => {
  const api = apiWithState();
  await api.abortBrew();
  await api.resumeBrew();
  await api.skipBrewStep();
  assert.deepEqual(api.commands.map(({ properties }) => properties.CtrlCmd), [4, 5, 3]);
  assert.ok(api.commands.every(({ properties }) => properties.SesOwnId === 12345));
});

test('bean and roast writes include both settings and reject unknown partner values', async() => {
  const api = apiWithState();
  await api.setRitaBeanOrRoast('BeanType', 1);
  assert.deepEqual({ ...api.commands[0].properties, SesOwnId: 0 }, {
    CtrlCmd: 14, SesOwnId: 0, BeanType: 1, RoastLevel: 2,
  });
  delete api.state.properties.airfryer.RoastLevel;
  await assert.rejects(api.setRitaBeanOrRoast('BeanType', 2), /Wait until/);
  assert.equal(api.commands.length, 1);
});

test('per-model Rita cloud catalog filters unsupported entries', async() => {
  const api = apiWithState();
  api.accessToken = 'test-access-token';
  api.state.properties.hostFirmwareVersion = '1.7.0';
  api.config.deviceId = 'device-1';
  api.cloud.getDevices = async() => [{ id: 'device-1', ctn: 'EP8757/20' }];
  api.cloud.getRitaCapabilities = async() => [
    { drinkID: 14, drinkName: 'Cappuccino', ctnNumbers: ['EP8757/20'] },
    { drinkID: 21, drinkName: 'Hot Water', ctnNumbers: ['EP8757/20'] },
    { drinkID: 2, drinkName: 'Espresso', ctnNumbers: ['OTHER'] },
  ];
  await api.fetchRitaCatalog();
  assert.deepEqual(api.ritaDrinks(), { 14: 'Cappuccino' });
  await assert.rejects(api.brewBuiltin(1, 2), /Unsupported drink/);
  await api.brewBuiltin(1, 14);
  assert.equal(api.commands[0].properties.Recipe_id, 14);
});

test('Rita capabilities request uses the machine and firmware without exposing tokens', async() => {
  const cloud = new PhilipsCloudApi();
  let request;
  cloud.client.request = async(url, options) => {
    request = { url, options };
    return { status: 200, body: '[]' };
  };
  assert.deepEqual(await cloud.getRitaCapabilities('secret-token', 'device/1', 'EP8757/20', '1.7.0'), []);
  assert.match(request.url, /device\/device%2F1\/capabilities\?proposition=EP8757%2F20&version=1\.7\.0/);
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
  assert.equal(request.url.includes('secret-token'), false);
});
