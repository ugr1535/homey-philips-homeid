'use strict';

const Homey = require('homey');
const PhilipsLocalApi = require('./local-api');
const PhilipsFusionApi = require('./fusion-api');
const { DRINKS, varintField } = require('./rita');
const { PORTS, portForModel } = require('./constants');

const COOKING_STATES = new Set(['cooking', 'precook', 'parasetting', 'maintain', 'user_action']);
const RITA_CAPABILITIES = [
  'onoff', 'homeid_machine_state', 'homeid_machine_status', 'homeid_machine_alert',
  'homeid_control_status', 'homeid_bean_type', 'homeid_roast_level',
  'homeid_aquaclean_filter_number', 'homeid_aquaclean_autonomy',
  'homeid_descale_autonomy', 'homeid_coffee_autonomy',
  'homeid_brew_group_autonomy',
  'homeid_brew_profile', 'homeid_saved_recipe', 'homeid_builtin_drink',
  'homeid_bean_selection', 'homeid_roast_selection',
  'homeid_brew_builtin', 'homeid_brew_saved', 'homeid_brew_hot_water',
  'homeid_abort_brew', 'homeid_resume_brew', 'homeid_skip_step',
];
const LOCAL_ESPRESSO_CAPABILITIES = [
  'onoff', 'homeid_machine_state', 'homeid_brew_progress',
  'homeid_water_level', 'homeid_bean_level',
];
const RITA_STATES = { 0: 'not_used', 1: 'brewing', 2: 'action_required', 3: 'unrecoverable_error' };
const RITA_STATUSES = {
  0: 'not_used', 1: 'running', 2: 'suspended_alarm',
  3: 'suspended_resumable', 4: 'finishing_successfully', 5: 'finishing_unsuccessfully',
};
const RITA_ALERTS = {
  0: 'not_used', 1: 'bean_lack', 2: 'water_lack', 3: 'ground_container_full',
  4: 'brew_unit_missing', 5: 'water_container_should_be_removed',
  6: 'drip_tray_removed', 7: 'door_open', 8: 'ground_container_removed',
  9: 'masterpiece_alarm', 20: 'user_abort_or_suspend_timeout',
  21: 'brew_abort_refill_required', 22: 'brew_abort_heater_fail',
  23: 'brew_abort_bu_fail', 24: 'brew_abort_grinder_fail',
  40: 'error_1', 41: 'error_2', 42: 'error_3', 43: 'error_4',
  44: 'error_5', 45: 'error_10', 46: 'error_11', 47: 'error_14',
  48: 'error_15', 49: 'error_19', 50: 'error_24',
};
const RITA_CONTROL_STATUSES = {
  1: 'machine_notification', 2: 'no_error', 3: 'invalid_command',
  50: 'non_existent_or_invalid_recipe', 51: 'machine_busy',
  52: 'machine_in_alarm_or_error_state', 100: 'profiles_full',
  101: 'unavailable_color', 102: 'invalid_profile_name',
  103: 'no_recipe_selected', 104: 'recipes_full', 105: 'invalid_recipe_name',
  106: 'invalid_profile_id', 107: 'invalid_profile_order',
  150: 'invalid_barista_assistant_settings',
};
const COOKING_METHODS = Object.freeze({
  spectre: { 0: 'Manual', 1: 'Frozen snacks', 2: 'Fresh fries', 3: 'Chicken', 4: 'Fish', 5: 'Muffins / cake', 6: 'Meat / chops', 7: 'Vegetables', 8: 'Keep warm' },
  venus: { 0: 'Manual', 1: 'Auto cook', 2: 'Keep warm', 3: 'Recipe', 4: 'No selection' },
  nutrimax: { 0: 'Air steam', 1: 'Steaming', 2: 'Roast', 3: 'Bake', 4: 'Slow cook', 5: 'Defrost', 6: 'Reheat', 7: 'Sous vide', 8: 'Manual', 9: 'Keep warm' },
  hermes: { 0: 'No selection', 1: 'Manual', 2: 'Air steam', 3: 'Roast', 4: 'Bake', 11: 'Steaming', 12: 'Air steam pro', 13: 'Defrost', 14: 'Reheat', 15: 'Stew', 30: 'User preset', 40: 'Recipe', 50: 'Keep warm', 60: 'Easy clean' },
});
const OPTIONAL_SENSORS = Object.freeze({
  airfryer: {
    homeid_recipe_name: ['recipeName', 'string'], homeid_cooking_error: ['error', 'string'],
    homeid_recipe_id: ['recipe_id', 'string'], homeid_step_id: ['step_id', 'string'],
    homeid_current_stage: ['cur_stage', 'number'], homeid_ingredient: ['ingredient', 'string'],
    homeid_probe_current: ['current_temp_probe', 'number'], homeid_previous_status: ['prev_status', 'string'],
    homeid_flip_reminder: ['flip', 'boolean'], homeid_probe_unplugged: ['probe_unplugged', 'boolean'],
    homeid_probe_required: ['probe_required', 'boolean'], homeid_resting: ['resting', 'boolean'],
    homeid_keep_warm_state: ['keep_warm', 'string'], homeid_cooking_id: ['cooking_id', 'string'],
    homeid_voltage: ['voltage', 'number'],
    homeid_left_status: ['status_l', 'string'], homeid_right_status: ['status_r', 'string'],
    homeid_left_temperature: ['temp_l', 'number'], homeid_right_temperature: ['temp_r', 'number'],
    homeid_left_time: ['time_l', 'number'], homeid_right_time: ['time_r', 'number'],
    homeid_left_drawer_open: ['drawer_open_l', 'boolean'],
    homeid_right_drawer_open: ['drawer_open_r', 'boolean'],
  },
  autocook: {
    homeid_autocook_uuid: ['UUID', 'string'], homeid_autocook_doneness: ['doneness', 'number'],
    homeid_autocook_amount: ['u1', 'string'], homeid_autocook_weight: ['u2', 'string'],
    homeid_autocook_thickness: ['u3', 'string'],
  },
  recipe: { homeid_recipe_current_stage: ['cur_stage', 'number'] },
  air_purifier: {
    homeid_pm1: ['pm1', 'number'], homeid_pm10: ['pm10', 'number'],
    homeid_tvoc: ['tvoc', 'number'], homeid_allergen_index: ['aqit', 'number'],
    homeid_filter_pre: ['fltsts0', 'number'], homeid_filter_hepa: ['fltsts1', 'number'],
    homeid_filter_carbon: ['fltsts2', 'number'], homeid_filter_wick: ['wicksts', 'number'],
    homeid_filter0_remaining_hours: ['D0520D', 'number'], homeid_filter1_remaining_hours: ['D0540E', 'number'],
    homeid_water_level: ['wl', 'number'], homeid_purifier_error: ['err', 'string'],
    homeid_gas: ['gas', 'number'], homeid_display_brightness: ['uil', 'number'],
    homeid_runtime: ['runtime', 'number'], homeid_purifier_raw_mode: ['mode', 'string'],
    homeid_fan_speed: ['om', 'string'], homeid_filter0_lifetime_hours: ['D05207', 'number'],
    homeid_filter1_lifetime_hours: ['D05408', 'number'],
  },
});

function enumName(value, names) {
  if (value === undefined || value === null) return null;
  return names[value] || `unknown (${value})`;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  const number = finiteNumber(value);
  return number === null ? null : Math.min(max, Math.max(min, number));
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'ON';
}

class PhilipsHomeIdDevice extends Homey.Device {
  async onInit() {
    this.deviceType = this.getStoreValue('deviceType') || this.driver.id;
    this.pollTimer = null;
    this.refreshing = false;
    this.lastState = null;
    this.lastStateAt = null;
    this.widgetDrink = null;
    this.pendingFusionState = null;
    this.processingFusionState = false;
    this.deleted = false;
    this.ritaMenuSignatures = {};
    this.cookingMethodSignature = null;
    this.cookingMethodRetryAt = 0;
    await this.syncInformationalSettings().catch((error) => {
      this.error(`Could not update device information: ${error.message}`);
    });
    if (this.deviceType === 'espresso') {
      await this.syncEspressoCapabilities().catch((error) => {
        this.error(`Could not update espresso measurements: ${error.message}`);
      });
    }
    this.api = this.createApi();
    this.registerCapabilityListeners();

    if (this.getStoreValue('connection') === 'fusion') {
      this.api.onState((state) => this.enqueueFusionState(state));
      this.api.onConnection((connected) => (connected
        ? this.setAvailable()
        : this.setUnavailable(this.homey.__('errors.cloud'))));
      try {
        await this.api.connect();
        await this.setAvailable();
        const state = this.api.getFullState();
        if (Object.keys(state?.properties || {}).length) this.enqueueFusionState(state);
      } catch (error) {
        this.error(`FUSION startup failed: ${error.message}`);
        await this.setUnavailable(this.homey.__('errors.cloud'));
        this.api.scheduleReconnect();
      }
      this.schedulePoll(300000);
    } else {
      await this.refreshNow().catch(() => undefined);
    }
  }

  isRitaEspresso() {
    return this.deviceType === 'espresso' && this.getStoreValue('connection') === 'fusion';
  }

  getModel() {
    return this.getStoreValue('model') || this.getSetting('model') || '';
  }

  async syncInformationalSettings() {
    const settings = {};
    const model = this.getModel();
    const connection = this.getStoreValue('connection') || '';
    if (this.getSetting('model') !== model) settings.model = model;
    if (this.getSetting('connection') !== connection) settings.connection = connection;
    if (Object.keys(settings).length) await this.setSettings(settings);
  }

  enqueueFusionState(state) {
    if (this.deleted) return;
    this.pendingFusionState = state;
    if (this.processingFusionState) return;
    this.processingFusionState = true;
    const drain = async() => {
      try {
        while (this.pendingFusionState && !this.deleted) {
          const latest = this.pendingFusionState;
          this.pendingFusionState = null;
          try {
            await this.applyState(latest);
          } catch (error) {
            this.error(`FUSION state update failed: ${error.message}`);
          }
        }
      } finally {
        this.processingFusionState = false;
      }
    };
    drain().catch((error) => this.error(`FUSION state drain failed: ${error.message}`));
  }

  async syncEspressoCapabilities() {
    const wanted = this.isRitaEspresso() ? RITA_CAPABILITIES : LOCAL_ESPRESSO_CAPABILITIES;
    for (const capability of wanted) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
    for (const capability of [...RITA_CAPABILITIES, ...LOCAL_ESPRESSO_CAPABILITIES]) {
      if (!wanted.includes(capability) && this.hasCapability(capability)) await this.removeCapability(capability);
    }
  }

  createApi() {
    const store = this.getStore();
    const config = {
      ...store,
      model: this.getModel(),
      host: this.getSetting('host') || store.host || '',
      deviceType: this.deviceType,
    };
    if (store.connection === 'fusion') {
      return new PhilipsFusionApi({
        ...config,
        onRefreshToken: (refreshToken) => this.setStoreValue('refreshToken', refreshToken),
      }, this);
    }
    return new PhilipsLocalApi(config, this);
  }

  registerCapabilityListeners() {
    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', async(value) => {
        await this.api.setPower(this.deviceType, value);
        this.schedulePoll(1500);
      });
    }
    if (this.hasCapability('target_temperature')) {
      this.registerCapabilityListener('target_temperature', async(value) => {
        await this.api.setCookingSettings({ temperature: value });
        this.schedulePoll(1500);
      });
    }
    if (this.hasCapability('homeid_total_time')) {
      this.registerCapabilityListener('homeid_total_time', async(value) => {
        await this.api.setCookingSettings({ durationSeconds: Math.round(value * 60) });
        this.schedulePoll(1500);
      });
    }
    if (this.hasCapability('homeid_cooking_method')) {
      this.registerCapabilityListener('homeid_cooking_method', (value) => this.setCookingMethod(value));
    }
    if (this.hasCapability('homeid_preheat')) {
      this.registerCapabilityListener('homeid_preheat', async(value) => {
        await this.api.setCookingSettings({ preheat: value });
        this.schedulePoll(1500);
      });
    }
    if (this.hasCapability('homeid_operation_mode')) {
      this.registerCapabilityListener('homeid_operation_mode', async(value) => {
        await this.api.setPurifierMode(value);
        this.schedulePoll(1500);
      });
    }
    if (this.hasCapability('homeid_child_lock')) {
      this.registerCapabilityListener('homeid_child_lock', async(value) => {
        await this.api.setChildLock(value);
        this.schedulePoll(1500);
      });
    }
    for (const [capability, field] of [
      ['homeid_purifier_beep_volume', 'D03130'],
      ['homeid_purifier_quality_threshold', 'D0312C'],
      ['homeid_purifier_standby_monitor', 'D03134'],
    ]) {
      if (this.hasCapability(capability)) this.registerPurifierSetting(capability, field);
    }
    for (const [capability, field] of [
      ['homeid_airspeed', 'airspeed'], ['homeid_probe_target', 'probeTemperature'],
    ]) {
      if (this.hasCapability(capability)) this.registerCookingSetting(capability, field);
    }
    if (this.isRitaEspresso()) {
      this.registerRitaListeners();
    }
    for (const [capability, field] of [
      ['homeid_grinder_dose', 'GrDose'], ['homeid_brew_temperature', 'Temperature'],
      ['homeid_brew_count', 'NrOfBrews'], ['homeid_primary_dose', 'PrimDose'],
      ['homeid_secondary_dose', 'SecDose'],
    ]) {
      if (this.hasCapability(capability) && this.isRitaEspresso()) this.registerBasicRecipeSetting(capability, field);
    }
  }

  registerBasicRecipeSetting(capability, field) {
    this.registerCapabilityListener(capability, async(value) => {
      await this.api.setBasicRecipeSetting(field, Number(value));
      this.schedulePoll(1500);
    });
  }

  registerPurifierSetting(capability, field) {
    this.registerCapabilityListener(capability, async(value) => {
      await this.api.setPurifierSetting(field, value);
      this.schedulePoll(1500);
    });
  }

  registerCookingSetting(capability, field) {
    this.registerCapabilityListener(capability, async(value) => {
      await this.api.setCookingSettings({ [field]: Number(value) });
      this.schedulePoll(1500);
    });
  }

  async ensureOptionalCapability(capability, writableField = null) {
    if (this.hasCapability(capability)) return;
    await this.addCapability(capability);
    if (writableField?.startsWith('D')) this.registerPurifierSetting(capability, writableField);
    else if (writableField) this.registerCookingSetting(capability, writableField);
  }

  cookingArchitecture() {
    const port = this.api?.airfryerPort || portForModel(this.getModel());
    if (port === PORTS.NUTRIMAX) return 'nutrimax';
    if (port === PORTS.HERMES) return 'hermes';
    if ([PORTS.VENUS_1, PORTS.VENUS_2].includes(port) || this.api?.isVenus?.()) return 'venus';
    return 'spectre';
  }

  async updateCookingMethodOptions() {
    if (typeof this.setCapabilityOptions !== 'function' || !this.hasCapability('homeid_cooking_method')) return;
    if (Date.now() < this.cookingMethodRetryAt) return;
    const architecture = this.cookingArchitecture();
    if (this.cookingMethodSignature === architecture) return;
    const values = Object.entries(COOKING_METHODS[architecture]).map(([id, name]) => ({ id, title: { en: name, tr: name } }));
    try {
      await this.setCapabilityOptions('homeid_cooking_method', { values });
      this.cookingMethodSignature = architecture;
    } catch (error) {
      this.cookingMethodRetryAt = Date.now() + 300000;
      this.error(`Cooking method labels unavailable: ${error.message}`);
    }
  }

  async syncOptionalSensors(values, definitions) {
    for (const [capability, [key, type]] of Object.entries(definitions)) {
      const raw = values[key];
      if (raw === undefined || raw === null || raw === '') continue;
      try {
        await this.ensureOptionalCapability(capability);
        let value = String(raw);
        if (type === 'number') value = finiteNumber(raw);
        if (type === 'boolean') value = booleanValue(raw);
        await this.setValue(capability, value);
      } catch (error) {
        this.error(`Could not add ${capability}: ${error.message}`);
      }
    }
  }

  registerRitaListeners() {
    const listen = (capability, handler) => {
      if (this.hasCapability(capability)) this.registerCapabilityListener(capability, handler);
    };
    listen('homeid_brew_profile', async(value) => {
      this.api.ritaProfileId(Number(value));
      await this.updateRitaMenus(Number(value));
    });
    listen('homeid_saved_recipe', async(value) => {
      if (value === 'none') return;
      const slot = this.ritaSelectedProfile() * 8 + Number(value);
      if (!this.api.ritaSavedRecipes(this.ritaSelectedProfile()).some((item) => item.slot === slot)) {
        throw new Error('This profile has no recipe in the selected slot');
      }
    });
    listen('homeid_builtin_drink', async(value) => {
      if (!this.api.ritaDrinks()[value]) throw new Error('Unsupported built-in drink');
    });
    listen('homeid_bean_selection', async(value) => {
      await this.api.setRitaBeanOrRoast('BeanType', value);
      this.schedulePoll(2000);
    });
    listen('homeid_roast_selection', async(value) => {
      await this.api.setRitaBeanOrRoast('RoastLevel', value);
      this.schedulePoll(2000);
    });
    for (const [capability, action] of Object.entries({
      homeid_brew_builtin: () => this.brewBuiltin(),
      homeid_brew_saved: () => this.brewSaved(),
      homeid_brew_hot_water: () => this.brewHotWater(),
      homeid_abort_brew: () => this.abortBrew(),
      homeid_resume_brew: () => this.resumeBrew(),
      homeid_skip_step: () => this.skipBrewStep(),
    })) listen(capability, (value) => (value === false ? undefined : action()));
  }

  ritaSelectedProfile() {
    const chosen = Number(this.getCapabilityValue('homeid_brew_profile'));
    const profiles = this.api.ritaProfiles();
    return profiles.find((profile) => profile.slot === chosen)?.slot ?? profiles[0]?.slot ?? 0;
  }

  async updateRitaMenuOptions(capability, entries) {
    if (!entries.length || !this.hasCapability(capability) || typeof this.setCapabilityOptions !== 'function') return;
    if (Date.now() < (this.ritaMenuOptionsRetryAt || 0)) return;
    const values = entries.map(({ id, name }) => ({ id: String(id), title: { en: name, tr: name } }));
    const signature = JSON.stringify(values);
    this.ritaMenuSignatures ||= {};
    if (this.ritaMenuSignatures[capability] === signature) return;
    try {
      await this.setCapabilityOptions(capability, { values });
      this.ritaMenuSignatures[capability] = signature;
    } catch (error) {
      this.ritaMenuOptionsRetryAt = Date.now() + 300000;
      if (!this.ritaMenuOptionErrorLogged) {
        this.error(`Dynamic Rita menu labels unavailable: ${error.message}`);
        this.ritaMenuOptionErrorLogged = true;
      }
    }
  }

  async updateRitaMenus(preferredProfile) {
    if (!this.isRitaEspresso() || !this.api?.ritaProfiles) return;
    const profiles = this.api.ritaProfiles();
    if (!profiles.length) return;
    let profile = this.ritaSelectedProfile();
    if (profiles.some((item) => item.slot === preferredProfile)) profile = preferredProfile;
    await this.setValue('homeid_brew_profile', String(profile));
    await this.updateRitaMenuOptions('homeid_brew_profile', profiles.map((item) => ({ id: item.slot, name: item.name })));
    const recipes = this.api.ritaSavedRecipes(profile);
    const selected = this.getCapabilityValue('homeid_saved_recipe');
    if (!recipes.length) await this.setValue('homeid_saved_recipe', 'none');
    else if (!recipes.some((item) => item.slot === profile * 8 + Number(selected))) {
      await this.setValue('homeid_saved_recipe', String(recipes[0].slot - profile * 8));
    }
    await this.updateRitaMenuOptions('homeid_saved_recipe', recipes.length
      ? recipes.map((item) => ({ id: item.slot - profile * 8, name: item.name }))
      : [{ id: 'none', name: 'No saved recipes' }]);
    const drinks = this.api.ritaDrinks();
    const chosenDrink = this.getCapabilityValue('homeid_builtin_drink');
    if (!drinks[chosenDrink]) await this.setValue('homeid_builtin_drink', String(Object.keys(drinks)[0]));
    await this.updateRitaMenuOptions('homeid_builtin_drink', Object.entries(drinks).map(([id, name]) => ({ id, name })));
  }

  async refreshNow() {
    if (this.refreshing) return this.lastState;
    this.refreshing = true;
    try {
      const state = await this.api.getFullState(this.deviceType);
      if (!state) throw new Error('Device returned no state');
      await this.applyState(state);
      await this.setAvailable();
      return state;
    } catch (error) {
      this.error(`Refresh failed: ${error.message}`);
      await this.setUnavailable(this.homey.__('errors.offline'));
      throw error;
    } finally {
      this.refreshing = false;
      const active = this.isCooking();
      const seconds = Number(this.getSetting(active ? 'active_poll_interval' : 'poll_interval'))
        || (active ? 10 : 60);
      this.schedulePoll(seconds * 1000);
    }
  }

  schedulePoll(delay) {
    if (this.deleted) return;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    this.pollTimer = this.homey.setTimeout(() => {
      if (this.deleted) return;
      if (this.getStoreValue('connection') === 'fusion') {
        try {
          if (this.api.connected) this.api.requestState({ activeOnly: this.isCooking() });
        } catch (error) {
          this.error(`FUSION refresh failed: ${error.message}`);
        }
        this.schedulePoll(this.api.connected && this.isCooking() ? 20000 : 300000);
      } else {
        this.refreshNow().catch(() => undefined);
      }
    }, Math.max(500, delay));
  }

  async setValue(capability, value) {
    if (!this.hasCapability(capability) || value === undefined || value === null) return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    if (this.getCapabilityValue(capability) === value) return;
    try {
      await this.setCapabilityValue(capability, value);
    } catch (error) {
      this.error(`Could not update ${capability}: ${error.message}`);
    }
  }

  async applyState(state) {
    const wasCooking = this.isCooking();
    this.lastState = state;
    this.lastStateAt = Date.now();
    const properties = state.properties || {};
    await this.setValue('onoff', Boolean(state.powerOn));
    if (this.deviceType === 'airfryer' || this.deviceType === 'multicooker') {
      await this.applyCookingState(properties.airfryer || {});
      await this.syncOptionalSensors(properties.autocook || {}, OPTIONAL_SENSORS.autocook);
      await this.syncOptionalSensors(properties.recipe || {}, OPTIONAL_SENSORS.recipe);
    } else if (this.deviceType === 'air_purifier') {
      await this.applyPurifierState(properties);
    } else if (this.deviceType === 'espresso') {
      await this.applyEspressoState(properties);
      this.updateWidgetDrink();
      if (this.isRitaEspresso()) await this.applyBasicRecipeState(properties.basicrecipe || {});
    }
    const firmware = properties.firmware || {};
    const rawVersion = firmware.version ?? properties.ncpFirmwareVersion ?? properties.hostFirmwareVersion;
    const version = Array.isArray(rawVersion) ? rawVersion.join(', ') : rawVersion;
    if (version) {
      const firmwareVersion = String(version);
      if (this.getSetting('firmware') !== firmwareVersion) {
        try {
          await this.setSettings({ firmware: firmwareVersion });
        } catch (error) {
          this.error(`Could not update firmware information: ${error.message}`);
        }
      }
      // Keep an existing capability current so older Flow references do not break.
      await this.setValue('homeid_firmware', firmwareVersion);
    }
    if (firmware.upgrade !== undefined && firmware.upgrade !== null) {
      try {
        await this.ensureOptionalCapability('homeid_firmware_upgrade');
        await this.setValue('homeid_firmware_upgrade', booleanValue(firmware.upgrade));
      } catch (error) {
        this.error(`Could not add firmware update status: ${error.message}`);
      }
    }
    if (this.getStoreValue('connection') === 'fusion' && this.api?.connected === false) {
      await this.setUnavailable(this.homey.__('errors.cloud'));
    } else {
      await this.setAvailable();
    }
    if (this.getStoreValue('connection') === 'fusion' && wasCooking !== this.isCooking()) {
      this.schedulePoll(this.isCooking() ? 20000 : 300000);
    }
  }

  async applyCookingState(cooking) {
    await this.updateCookingMethodOptions();
    await this.syncOptionalSensors(cooking, OPTIONAL_SENSORS.airfryer);
    if (this.hasCapability('homeid_temp_unit_fahrenheit') && cooking.temp_unit !== undefined) {
      await this.setValue('homeid_temp_unit_fahrenheit', booleanValue(cooking.temp_unit));
    }
    for (const [capability, key, field] of [
      ['homeid_airspeed', 'airspeed', 'airspeed'],
      ['homeid_probe_target', 'temp_probe', 'probeTemperature'],
    ]) {
      if (cooking[key] === undefined || cooking[key] === null) continue;
      try {
        await this.ensureOptionalCapability(capability, field);
        await this.setValue(capability, finiteNumber(cooking[key]));
      } catch (error) {
        this.error(`Could not add ${capability}: ${error.message}`);
      }
    }
    await Promise.all([
      this.setValue('homeid_cooking_status', cooking.status ? String(cooking.status) : null),
      this.setValue('target_temperature', clamp(cooking.temp, 30, 230)),
      this.setValue('measure_temperature', clamp(cooking.cur_temp ?? cooking.current_temp, -20, 300)),
      this.setValue('homeid_total_time', finiteNumber(cooking.time) === null ? null : Math.max(1, Math.round(Number(cooking.time) / 60))),
      this.setValue('homeid_remaining_time', finiteNumber(cooking.cur_time) === null ? null : Math.max(0, Math.ceil(Number(cooking.cur_time) / 60))),
      this.setValue('homeid_cooking_method', this.validCookingMethod(cooking.preset)),
      this.setValue('homeid_preheat', cooking.preheat === undefined ? null : booleanValue(cooking.preheat)),
      this.setValue('homeid_drawer_open', cooking.drawer_open === undefined ? null : booleanValue(cooking.drawer_open)),
      this.setValue('homeid_shake_reminder', cooking.shake === undefined ? null : booleanValue(cooking.shake)),
      this.setValue('homeid_lid_open', cooking.lid_open === undefined ? null : booleanValue(cooking.lid_open)),
      this.setValue('homeid_no_water', cooking.no_water === undefined ? null : booleanValue(cooking.no_water)),
      this.setValue('measure_humidity', clamp(cooking.humidity, 0, 100)),
    ]);
  }

  validCookingMethod(value) {
    if (value === undefined || value === null) return null;
    const candidate = String(value);
    return Object.hasOwn(COOKING_METHODS[this.cookingArchitecture()], candidate)
      ? candidate
      : null;
  }

  async applyPurifierState(properties) {
    await this.syncOptionalSensors(properties, OPTIONAL_SENSORS.air_purifier);
    for (const [capability, key] of [
      ['homeid_filter_replace_required', 'fltsts1'],
      ['homeid_water_tank_empty', 'wl'],
    ]) {
      const value = finiteNumber(properties[key]);
      if (value === null) continue;
      try {
        await this.ensureOptionalCapability(capability);
        await this.setValue(capability, value === 0);
      } catch (error) {
        this.error(`Could not add ${capability}: ${error.message}`);
      }
    }
    for (const [capability, key] of [
      ['homeid_purifier_beep_volume', 'D03130'],
      ['homeid_purifier_quality_threshold', 'D0312C'],
      ['homeid_purifier_standby_monitor', 'D03134'],
    ]) {
      if (properties[key] === undefined || properties[key] === null) continue;
      try {
        await this.ensureOptionalCapability(capability, key);
        const value = key === 'D03134' ? booleanValue(properties[key]) : finiteNumber(properties[key]);
        await this.setValue(capability, value);
      } catch (error) {
        this.error(`Could not add ${capability}: ${error.message}`);
      }
    }
    const filterRemaining = this.filterPercentage(properties);
    await Promise.all([
      this.setValue('measure_pm25', clamp(properties.D03221 ?? properties.pm25, 0, 10000)),
      this.setValue('homeid_air_quality_index', clamp(properties.D03120 ?? properties.aqi, 0, 500)),
      this.setValue('measure_temperature', clamp(properties.temp, -50, 100)),
      this.setValue('measure_humidity', clamp(properties.rh, 0, 100)),
      this.setValue('homeid_filter_remaining', filterRemaining),
      this.setValue('alarm_generic', filterRemaining === null ? null : filterRemaining <= 5),
      this.setValue('homeid_operation_mode', this.purifierMode(properties.D0310C ?? properties.mode ?? properties.om)),
      this.setValue('homeid_child_lock', properties.cl === undefined ? null : booleanValue(properties.cl)),
    ]);
  }

  filterPercentage(properties) {
    const direct = [properties.fltsts1, properties.fltsts0].map(finiteNumber).find((value) => value !== null);
    if (direct !== undefined) return clamp(direct, 0, 100);
    const remaining = finiteNumber(properties.D0540E ?? properties.D0520D);
    const lifetime = finiteNumber(properties.D05408 ?? properties.D05207);
    if (remaining === null || lifetime === null || lifetime <= 0) return null;
    return clamp(Math.round((remaining / lifetime) * 100), 0, 100);
  }

  purifierMode(value) {
    const local = this.getStoreValue('connection') !== 'fusion';
    const modeMap = local
      ? { A: 'auto', M: 'medium', S: 'sleep', s: 'sleep', t: 'turbo', 0: 'auto', 1: 'gentle', 2: 'medium', 3: 'fast' }
      : { 0: 'auto', 1: 'medium', 2: 'fast', 17: 'sleep', 18: 'turbo' };
    if (!local && Number(value) === 1 && this.getModel().toUpperCase().includes('AC0650')) return 'gentle';
    return modeMap[value] || null;
  }

  async applyEspressoState(properties) {
    if (this.isRitaEspresso()) {
      const rita = properties.airfryer || properties.Status || {};
      await Promise.all([
        this.setValue('homeid_machine_state', enumName(rita.McState, RITA_STATES) || 'unknown'),
        this.setValue('homeid_machine_status', enumName(rita.McStatus, RITA_STATUSES)),
        this.setValue('homeid_machine_alert', enumName(rita.McExInfo, RITA_ALERTS)),
        this.setValue('homeid_control_status', enumName(rita.CtrlStatus, RITA_CONTROL_STATUSES)),
        this.setValue('homeid_bean_type', enumName(rita.BeanType, { 0: 'arabica', 1: 'mix', 2: 'other' })),
        this.setValue('homeid_roast_level', enumName(rita.RoastLevel, { 0: 'light', 1: 'medium', 2: 'dark' })),
        this.setValue('homeid_bean_selection', [0, 1, 2].includes(Number(rita.BeanType)) ? String(rita.BeanType) : null),
        this.setValue('homeid_roast_selection', [0, 1, 2].includes(Number(rita.RoastLevel)) ? String(rita.RoastLevel) : null),
        this.setValue('homeid_aquaclean_filter_number', finiteNumber(rita.AqFiltNum)),
        this.setValue('homeid_aquaclean_autonomy', clamp(rita.AqAutmy, 0, 100)),
        this.setValue('homeid_descale_autonomy', clamp(rita.DescAutmy, 0, 100)),
        this.setValue('homeid_coffee_autonomy', clamp(rita.CorAutmy, 0, 100)),
        this.setValue('homeid_brew_group_autonomy', clamp(rita.MbcAutmy, 0, 100)),
      ]);
      await this.updateRitaMenus();
      return;
    }
    const local = properties.machinestatus || {};
    const rita = properties.airfryer || properties.Status || {};
    const rawState = local.mainstate ?? rita.McState ?? rita.status;
    const stateNames = {
      0: 'off', 1: 'standby', 2: 'ready', 3: 'brewing', 4: 'rinsing', 5: 'action_required',
    };
    await Promise.all([
      this.setValue('homeid_machine_state', rawState === undefined ? null : (stateNames[rawState] || String(rawState))),
      this.setValue('homeid_brew_progress', clamp(local.Progress ?? rita.Progress, 0, 100)),
      this.setValue('homeid_water_level', clamp(local.waterlevel ?? rita.WatLevel, 0, 100)),
      this.setValue('homeid_bean_level', clamp(local.beanlevel ?? rita.BeanLevel, 0, 100)),
    ]);
  }

  async applyBasicRecipeState(recipe) {
    for (const [capability, field] of [
      ['homeid_grinder_dose', 'GrDose'], ['homeid_brew_temperature', 'Temperature'],
      ['homeid_brew_count', 'NrOfBrews'], ['homeid_primary_dose', 'PrimDose'],
      ['homeid_secondary_dose', 'SecDose'],
    ]) {
      const value = finiteNumber(recipe[field]);
      if (value === null) continue;
      try {
        if (!this.hasCapability(capability)) {
          await this.addCapability(capability);
          this.registerBasicRecipeSetting(capability, field);
        }
        await this.setValue(capability, value);
      } catch (error) {
        this.error(`Could not add ${capability}: ${error.message}`);
      }
    }
  }

  isCooking() {
    const status = this.lastState?.properties?.airfryer?.status;
    return COOKING_STATES.has(status);
  }

  async startCooking({ temperature, durationMinutes, preheat = false }) {
    await this.api.startCooking({
      temperature: Number(temperature),
      durationSeconds: Math.round(Number(durationMinutes) * 60),
      preheat: Boolean(preheat),
    });
    this.schedulePoll(1500);
    return true;
  }

  async pauseCooking() {
    await this.api.pauseCooking();
    this.schedulePoll(1500);
    return true;
  }

  async stopCooking() {
    await this.api.stopCooking();
    this.schedulePoll(1500);
    return true;
  }

  async keepWarm(durationMinutes = 60) {
    await this.api.keepWarm(Math.round(Number(durationMinutes) * 60));
    this.schedulePoll(1500);
    return true;
  }

  async setCookingMethod(method) {
    if (!this.validCookingMethod(method)) throw new Error('This cooking method is not available on this model');
    await this.api.setCookingSettings({ method: Number(method) });
    this.schedulePoll(1500);
    return true;
  }

  async brewDrink(drink, volume) {
    if (this.getStoreValue('connection') !== 'fusion') await this.ensureLocalEspressoReady();
    const widgetRequest = this.widgetBrewRequest();
    await this.api.brewDrink(drink, Number(volume), this.isRitaEspresso() ? this.ritaSelectedProfile() : undefined);
    this.rememberWidgetDrink({
      id: { espresso: 2, coffee: 7, hot_water: 21 }[drink] || null,
      name: { espresso: 'Espresso', coffee: 'Caffè Crema', hot_water: 'Hot water' }[drink] || String(drink),
    }, widgetRequest);
    this.schedulePoll(2000);
    return true;
  }

  requireRita() {
    if (!this.isRitaEspresso()) throw new Error('This control requires a Philips cloud espresso machine');
  }

  async brewBuiltin(drinkId = this.getCapabilityValue('homeid_builtin_drink'), profileSlot = this.ritaSelectedProfile()) {
    this.requireRita();
    const widgetRequest = this.widgetBrewRequest();
    await this.api.brewBuiltin(Number(profileSlot), Number(drinkId));
    this.rememberWidgetDrink({ id: Number(drinkId), name: this.api.ritaDrinks()[drinkId] || DRINKS[drinkId] || 'Hot water' }, widgetRequest);
    this.schedulePoll(2000);
    return true;
  }

  async brewSaved(recipeSlot = this.getCapabilityValue('homeid_saved_recipe'), profileSlot = this.ritaSelectedProfile()) {
    this.requireRita();
    const widgetRequest = this.widgetBrewRequest();
    const slot = Number(recipeSlot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 7) throw new Error('Choose a saved recipe first');
    const recipe = this.api.ritaSavedRecipes(Number(profileSlot)).find((item) => item.slot === Number(profileSlot) * 8 + slot);
    await this.api.brewSaved(Number(profileSlot), Number(profileSlot) * 8 + slot);
    const drinkId = varintField(recipe?.blob, 2);
    const imageName = DRINKS[drinkId] || this.api.ritaDrinks?.()[drinkId] || null;
    this.rememberWidgetDrink({ id: drinkId, name: recipe?.name || 'Saved recipe', imageName }, widgetRequest);
    this.schedulePoll(2000);
    return true;
  }

  getWidgetBrewMenu() {
    if (!this.isRitaEspresso() || !this.api?.ritaProfiles) return { supported: false, profiles: [] };
    const drinkNames = this.api.ritaDrinks?.() || DRINKS;
    return {
      supported: true,
      selectedProfile: this.ritaSelectedProfile(),
      profiles: this.api.ritaProfiles().map((profile) => ({
        slot: profile.slot,
        name: String(profile.name).slice(0, 80),
        recipes: this.api.ritaSavedRecipes(profile.slot).map((recipe) => {
          const drinkId = varintField(recipe.blob, 2);
          return {
            slot: recipe.slot - profile.slot * 8,
            name: String(recipe.name).slice(0, 80),
            drinkId,
            imageName: DRINKS[drinkId] || drinkNames[drinkId] || null,
          };
        }),
      })),
    };
  }

  canStartWidgetBrew() {
    const state = this.getCapabilityValue('homeid_machine_state');
    return this.isRitaEspresso() && this.getAvailable() && this.api?.connected === true
      && this.getCapabilityValue('onoff') === true
      && ['not_used', 'ready', 'standby'].includes(state);
  }

  canControlWidgetPower() {
    return this.deviceType === 'espresso' && this.hasCapability('onoff') && this.getAvailable()
      && typeof this.api?.setPower === 'function'
      && (this.getStoreValue('connection') !== 'fusion' || this.api?.connected === true)
      && this.getCapabilityValue('homeid_machine_state') !== 'brewing';
  }

  async setWidgetPower(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Choose a valid power state');
    if (!this.canControlWidgetPower()) throw new Error('Espresso machine power is unavailable');
    if (this.widgetPowerInFlight) throw new Error('A power request is already in progress');
    if (this.getCapabilityValue('onoff') === enabled) return true;
    this.widgetPowerInFlight = true;
    try {
      await this.api.setPower('espresso', enabled);
      this.schedulePoll(1500);
      return true;
    } finally {
      this.widgetPowerInFlight = false;
    }
  }

  async brewSavedFromWidget(profileSlot, recipeSlot) {
    if (!Number.isInteger(profileSlot) || profileSlot < 0 || profileSlot > 7
      || !Number.isInteger(recipeSlot) || recipeSlot < 0 || recipeSlot > 7) {
      throw new Error('Invalid profile or saved recipe');
    }
    if (!this.canStartWidgetBrew()) throw new Error('Espresso machine is not ready for brewing');
    const profile = this.getWidgetBrewMenu().profiles.find((item) => item.slot === profileSlot);
    if (!profile?.recipes.some((item) => item.slot === recipeSlot)) {
      throw new Error('Saved recipe is no longer available in this profile');
    }
    if (this.widgetBrewInFlight || Date.now() - (this.widgetBrewRequestedAt || 0) < 15000) {
      throw new Error('A brew request was already sent');
    }
    this.widgetBrewInFlight = true;
    try {
      const result = await this.brewSaved(recipeSlot, profileSlot);
      this.widgetBrewRequestedAt = Date.now();
      return result;
    } finally {
      this.widgetBrewInFlight = false;
    }
  }

  async brewHotWater(profileSlot = this.ritaSelectedProfile()) {
    return this.brewBuiltin(21, profileSlot);
  }

  async abortBrew() { this.requireRita(); await this.api.abortBrew(); this.widgetDrink = null; this.schedulePoll(2000); return true; }

  widgetBrewRequest() {
    return {
      wasBrewing: this.getCapabilityValue('homeid_machine_state') === 'brewing',
      previousSessionId: Number(this.lastState?.properties?.airfryer?.SesOwnId) || null,
    };
  }

  rememberWidgetDrink({ id = null, name, imageName = name }, request = this.widgetBrewRequest()) {
    // This is only a Homey-initiated request, not proof that the machine accepted it.
    if (request.wasBrewing) {
      this.widgetDrink = null;
      return;
    }
    this.widgetDrink = {
      id,
      name,
      imageName,
      sessionId: this.api?.lastBrewSessionId || null,
      previousSessionId: request.previousSessionId,
      requestedAt: Date.now(),
      startedAt: null,
    };
    this.updateWidgetDrink();
  }

  updateWidgetDrink() {
    const drink = this.widgetDrink;
    if (!drink) return;
    const now = Date.now();
    const brewing = this.getCapabilityValue('homeid_machine_state') === 'brewing';
    const reportedSession = Number(this.lastState?.properties?.airfryer?.SesOwnId);
    let sessionReady = true;
    if (brewing && drink.sessionId && Number.isSafeInteger(reportedSession)
      && reportedSession > 0 && reportedSession !== drink.sessionId) {
      if (reportedSession !== drink.previousSessionId) {
        this.widgetDrink = null;
        return;
      }
      sessionReady = false;
    }
    if (brewing && sessionReady && !drink.startedAt && now - drink.requestedAt <= 120000) drink.startedAt = now;
    if ((!brewing && drink.startedAt) || (!drink.startedAt && now - drink.requestedAt > 120000)
      || (drink.startedAt && now - drink.startedAt > 900000)) this.widgetDrink = null;
  }

  getWidgetStatus() {
    this.updateWidgetDrink();
    const state = this.getCapabilityValue('homeid_machine_state') || 'unknown';
    const brewing = state === 'brewing';
    const powerOn = this.hasCapability('onoff') ? this.getCapabilityValue('onoff') : null;
    const confirmedRequest = brewing && this.widgetDrink?.startedAt;
    const maintenanceValue = (capability) => {
      if (!this.hasCapability(capability)) return null;
      const value = this.getCapabilityValue(capability);
      return value === null || value === undefined ? null : clamp(value, 0, 100);
    };
    return {
      deviceName: this.getName(),
      available: this.getAvailable(),
      powerOn: typeof powerOn === 'boolean' ? powerOn : null,
      canControlPower: this.canControlWidgetPower() && typeof powerOn === 'boolean',
      state,
      machineStatus: this.getCapabilityValue('homeid_machine_status') || null,
      alert: this.getCapabilityValue('homeid_machine_alert') || null,
      progress: this.getCapabilityValue('homeid_brew_progress') ?? null,
      drinkName: confirmedRequest ? this.widgetDrink.name : null,
      drinkId: confirmedRequest ? this.widgetDrink.id : null,
      drinkImageName: confirmedRequest ? this.widgetDrink.imageName : null,
      drinkSource: confirmedRequest ? 'homey_request' : null,
      savedRecipeControl: this.isRitaEspresso(),
      canStartBrew: this.canStartWidgetBrew(),
      maintenance: {
        aquaclean: maintenanceValue('homeid_aquaclean_autonomy'),
        descale: maintenanceValue('homeid_descale_autonomy'),
        coffee: maintenanceValue('homeid_coffee_autonomy'),
        brewGroup: maintenanceValue('homeid_brew_group_autonomy'),
      },
      updatedAt: this.lastStateAt,
    };
  }

  async resumeBrew() { this.requireRita(); await this.api.resumeBrew(); this.schedulePoll(2000); return true; }

  async skipBrewStep() { this.requireRita(); await this.api.skipBrewStep(); this.schedulePoll(2000); return true; }

  async setBeanType(value) { this.requireRita(); await this.api.setRitaBeanOrRoast('BeanType', value); this.schedulePoll(2000); return true; }

  async setRoastLevel(value) { this.requireRita(); await this.api.setRitaBeanOrRoast('RoastLevel', value); this.schedulePoll(2000); return true; }

  async ensureLocalEspressoReady() {
    let state = await this.api.getFullState('espresso');
    let mainState = Number(state.properties?.machinestatus?.mainstate);
    if (mainState === 2) return;
    if ([3, 5].includes(mainState)) throw new Error(`Espresso machine is not ready (state ${mainState})`);
    await this.api.setPower('espresso', true);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => this.homey.setTimeout(resolve, 3000));
      state = await this.api.getFullState('espresso');
      mainState = Number(state.properties?.machinestatus?.mainstate);
      if (mainState === 2) return;
      if ([3, 5].includes(mainState)) throw new Error(`Espresso machine is not ready (state ${mainState})`);
    }
    throw new Error('Espresso machine did not become ready within 90 seconds');
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('host') && this.getStoreValue('connection') === 'local') {
      await this.setStoreValue('host', newSettings.host);
      this.api.close();
      this.api = this.createApi();
    }
    if (changedKeys.some((key) => ['poll_interval', 'active_poll_interval'].includes(key))) {
      this.schedulePoll(100);
    }
  }

  async onDeleted() {
    this.deleted = true;
    this.pendingFusionState = null;
    if (this.pollTimer) this.homey.clearTimeout(this.pollTimer);
    this.api?.close();
  }
}

module.exports = PhilipsHomeIdDevice;
