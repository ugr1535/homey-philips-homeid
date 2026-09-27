'use strict';

const { createCondorAuthorization, decryptPayload, encryptPayload } = require('./crypto');
const { HttpClient } = require('./http-client');
const {
  ACTIVE_COOKING_STATES, PORTS, VENUS_PORTS, portForModel,
} = require('./constants');

const VENUS_TO_COMMON = Object.freeze({
  disp_time: 'cur_time',
  total_time: 'time',
  method: 'preset',
  current_temp: 'cur_temp',
  probe_unpl: 'probe_unplugged',
  probe_rqrd: 'probe_required',
  drw_opn: 'drawer_open',
  prev_stat: 'prev_status',
});

const COMMON_TO_VENUS = Object.fromEntries(Object.entries(VENUS_TO_COMMON).map(([key, value]) => [value, key]));

class PhilipsLocalApi {
  constructor(config, logger = console) {
    this.config = {
      protocolVersion: 1,
      productId: 1,
      useHttps: true,
      ...config,
    };
    this.log = logger;
    this.client = new HttpClient({ timeout: 10000, insecure: true });
    this.authorization = null;
    this.airfryerPort = config.airfryerPort || portForModel(config.model);
    this.firmwareCache = null;
    this.firmwareAttemptAt = 0;
    this.lastAirfryerStatus = null;
  }

  close() {
    this.client.close();
  }

  url(port, productId = this.config.productId) {
    const scheme = this.config.useHttps ? 'https' : 'http';
    const host = this.config.host.includes(':') && !this.config.host.startsWith('[')
      ? `[${this.config.host}]`
      : this.config.host;
    return `${scheme}://${host}/di/v${this.config.protocolVersion}/products/${productId}/${port}`;
  }

  async request(port, { method = 'GET', data, productId, retry = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Connection: 'keep-alive' };
    if (this.authorization) headers.Authorization = this.authorization;
    let body;
    if (data !== undefined) {
      const serialized = JSON.stringify(data);
      body = this.config.encryptionKey ? encryptPayload(serialized, this.config.encryptionKey) : serialized;
    }
    const response = await this.client.request(this.url(port, productId), {
      method,
      headers,
      body,
      timeout: 10000,
    });
    if (response.status === 401 && retry && this.config.clientId && this.config.clientSecret) {
      const challenge = response.headers['www-authenticate'];
      if (!challenge) throw new Error('Device requested authentication without a challenge');
      this.authorization = createCondorAuthorization(
        challenge,
        this.config.clientId,
        this.config.clientSecret,
      );
      return this.request(port, {
        method, data, productId, retry: false,
      });
    }
    if (response.status !== 200) {
      const error = new Error(`Device request failed: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    let text = response.body;
    if (this.config.encryptionKey) text = decryptPayload(text, this.config.encryptionKey);
    try {
      return JSON.parse(text);
    } catch (error) {
      return { raw: text };
    }
  }

  async probe() {
    const attempts = [
      { useHttps: this.config.useHttps },
      { useHttps: !this.config.useHttps },
    ];
    let lastError;
    for (const attempt of attempts) {
      this.config.useHttps = attempt.useHttps;
      try {
        const device = await this.request(PORTS.DEVICE);
        return { device, useHttps: attempt.useHttps };
      } catch (error) {
        lastError = error;
        if (error.status === 401 || error.status === 403) return { device: {}, useHttps: attempt.useHttps };
      }
    }
    throw lastError || new Error('Device is unreachable');
  }

  normalizeVenus(data) {
    const normalized = { ...data };
    for (const [venus, common] of Object.entries(VENUS_TO_COMMON)) {
      if (normalized[venus] !== undefined && normalized[common] === undefined) normalized[common] = normalized[venus];
    }
    return normalized;
  }

  toVenus(data) {
    const normalized = { ...data };
    for (const [common, venus] of Object.entries(COMMON_TO_VENUS)) {
      if (normalized[common] !== undefined) {
        normalized[venus] = normalized[common];
        delete normalized[common];
      }
    }
    return normalized;
  }

  async discoverAirfryerPort() {
    if (this.airfryerPort) return this.airfryerPort;
    const candidates = [PORTS.AIRFRYER, PORTS.VENUS_2, PORTS.VENUS_1, PORTS.NUTRIMAX, PORTS.HERMES];
    for (const port of candidates) {
      try {
        await this.request(port);
        this.airfryerPort = port;
        return port;
      } catch (error) {
        if (![404, 501].includes(error.status)) throw error;
      }
    }
    return null;
  }

  async exchangeEncryptionKey() {
    const result = await this.request(PORTS.SECURITY, { productId: 0 });
    const key = String(result.raw ?? result.key ?? '').trim();
    if (!key) throw new Error('Device did not return an encryption key');
    this.config.encryptionKey = key;
    return key;
  }

  async getFullState(type) {
    const properties = {};
    let powerOn = false;
    if (type === 'airfryer' || type === 'multicooker') {
      const port = await this.discoverAirfryerPort();
      if (!port) throw new Error('No compatible cooking port found');
      let status = await this.request(port);
      if (VENUS_PORTS.has(port)) status = this.normalizeVenus(status);
      this.lastAirfryerStatus = status;
      properties.airfryer = status;
      powerOn = ACTIVE_COOKING_STATES.has(status.status);
      if (VENUS_PORTS.has(port)) {
        for (const [name, endpoint] of [
          ['device_current_state', PORTS.DEVICE_CURRENT_STATE],
          ['autocook', PORTS.AUTOCOOK],
          ['recipe', PORTS.RECIPE],
        ]) {
          try {
            const value = await this.request(endpoint);
            if (name === 'device_current_state') Object.assign(status, this.normalizeVenus(value));
            else properties[name] = value;
          } catch (error) {
            if (![404, 501].includes(error.status)) this.log.debug?.(`Optional ${endpoint} read failed: ${error.message}`);
          }
        }
      }
    } else if (type === 'espresso') {
      const [machine, configuration] = await Promise.all([
        this.request(PORTS.MACHINE_STATUS),
        this.request(PORTS.CONFIGURATION).catch(() => ({})),
      ]);
      properties.machinestatus = machine;
      properties.configuration = configuration;
      powerOn = Number(machine.mainstate) >= 2;
    } else {
      const [status, air, filters] = await Promise.all([
        this.request(PORTS.STATUS),
        this.request(PORTS.AIR).catch(() => ({})),
        this.request(PORTS.FILTER).catch(() => ({})),
      ]);
      Object.assign(properties, status, air, filters);
      powerOn = status.pwr === '1' || status.pwr === 1 || status.powerOn === true;
    }
    if (Date.now() - this.firmwareAttemptAt > (this.firmwareCache ? 3600000 : 300000)) {
      this.firmwareAttemptAt = Date.now();
      try {
        this.firmwareCache = await this.request(PORTS.FIRMWARE, { productId: 0 });
      } catch (error) {
        this.log.debug?.(`Firmware read unavailable: ${error.message}`);
      }
    }
    if (this.firmwareCache) properties.firmware = this.firmwareCache;
    return { powerOn, properties };
  }

  async setPower(type, enabled) {
    if (type === 'espresso') {
      return this.request(PORTS.COMMAND, { method: 'PUT', data: { power: enabled ? 2 : 1 } });
    }
    if (type === 'air_purifier') {
      return this.request(PORTS.STATUS, { method: 'PUT', data: { pwr: enabled ? '1' : '0' } });
    }
    if (!enabled) return this.stopCooking();
    return true;
  }

  async setPurifierMode(mode) {
    const modeMap = { auto: 'A', gentle: '1', medium: '2', fast: '3', sleep: 's', turbo: 't' };
    return this.request(PORTS.STATUS, { method: 'PUT', data: { om: modeMap[mode] || mode } });
  }

  async setChildLock(enabled) {
    return this.request(PORTS.STATUS, { method: 'PUT', data: { cl: enabled } });
  }

  async setPurifierSetting(field, value) {
    if (!['D03130', 'D0312C', 'D03134'].includes(field)) throw new Error('Unsupported purifier setting');
    const numeric = field === 'D03134' ? (value ? 1 : 0) : Number(value);
    if (!Number.isInteger(numeric) || (field === 'D03130' && (numeric < 0 || numeric > 3))
      || (field === 'D0312C' && (numeric < 1 || numeric > 4))) throw new Error('Invalid purifier setting');
    return this.request(PORTS.STATUS, { method: 'PUT', data: { [field]: numeric } });
  }

  async setCookingSettings({ temperature, durationSeconds, method, preheat, rawTempUnit, airspeed, probeTemperature }) {
    const port = await this.discoverAirfryerPort();
    let data = { status: 'setting' };
    if (temperature !== undefined) data.temp = temperature;
    if (durationSeconds !== undefined) data.time = durationSeconds;
    if (method !== undefined) data.preset = Number(method);
    if (preheat !== undefined) data.preheat = Boolean(preheat);
    const currentUnit = rawTempUnit ?? this.lastAirfryerStatus?.temp_unit;
    if (currentUnit !== undefined && currentUnit !== null) data.temp_unit = Boolean(currentUnit);
    if (airspeed !== undefined) {
      if (!Number.isInteger(airspeed) || airspeed < 1 || airspeed > 2) throw new Error('Invalid airspeed');
      data.airspeed = airspeed;
    }
    if (probeTemperature !== undefined) {
      if (!Number.isInteger(probeTemperature) || probeTemperature < 40 || probeTemperature > 100) throw new Error('Invalid probe temperature');
      data.temp_probe = probeTemperature;
      data.probe_required = true;
    }
    if (VENUS_PORTS.has(port)) data = this.toVenus(data);
    return this.request(port, { method: 'PUT', data });
  }

  async startCooking({ temperature, durationSeconds, preheat = false }) {
    const port = await this.discoverAirfryerPort();
    if (VENUS_PORTS.has(port)) {
      await this.request(port, {
        method: 'PUT',
        data: this.toVenus({ status: 'precook', probe_required: false, preset: 0 }),
      });
      const settings = {};
      if (temperature !== undefined) settings.temp = temperature;
      if (durationSeconds !== undefined) settings.total_time = durationSeconds;
      if (Object.keys(settings).length) await this.request(port, { method: 'PUT', data: settings });
      return this.request(port, { method: 'PUT', data: { status: 'cooking' } });
    }
    return this.request(port, {
      method: 'PUT',
      data: {
        status: 'cooking',
        ...(temperature !== undefined ? { temp: temperature } : {}),
        ...(durationSeconds !== undefined ? { time: durationSeconds } : {}),
        ...(this.lastAirfryerStatus?.temp_unit === undefined ? {} : { temp_unit: Boolean(this.lastAirfryerStatus.temp_unit) }),
        preheat,
      },
    });
  }

  async pauseCooking() {
    const port = await this.discoverAirfryerPort();
    return this.request(port, { method: 'PUT', data: { status: 'pause' } });
  }

  async stopCooking() {
    const port = await this.discoverAirfryerPort();
    if (VENUS_PORTS.has(port)) {
      await this.request(port, { method: 'PUT', data: { status: 'pause' } }).catch(() => undefined);
      return this.request(port, { method: 'PUT', data: { status: 'mainmenu' } });
    }
    return this.request(port, { method: 'PUT', data: { status: 'standby' } });
  }

  async keepWarm(durationSeconds = 3600) {
    const port = await this.discoverAirfryerPort();
    if (VENUS_PORTS.has(port)) {
      const method = port === PORTS.NUTRIMAX ? 9 : port === PORTS.HERMES ? 50 : 2;
      return this.request(port, {
        method: 'PUT', data: { total_time: durationSeconds, method, status: 'maintain' },
      });
    }
    return this.request(port, {
      method: 'PUT', data: {
        time: durationSeconds, temp: 65, preset: 8, status: 'cooking',
        ...(this.lastAirfryerStatus?.temp_unit === undefined ? {} : { temp_unit: Boolean(this.lastAirfryerStatus.temp_unit) }),
      },
    });
  }

  async brewDrink(drink, volume = 40) {
    const recipes = {
      espresso: { RecipeBookId: 2, PrimDose: volume || 40 },
      coffee: { RecipeBookId: 6, PrimDose: volume || 120 },
    };
    const recipe = recipes[drink];
    if (!recipe) throw new Error(`Unsupported drink: ${drink}`);
    return this.request(PORTS.BASIC_RECIPE, {
      method: 'PUT',
      data: {
        ...recipe,
        GrDose: 2,
        SecDose: 0,
        Temperature: 2,
        NrOfBrews: 0,
        randnr: Math.floor(Math.random() * 0x7fffffff),
      },
    });
  }
}

module.exports = PhilipsLocalApi;
