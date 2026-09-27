'use strict';

const crypto = require('crypto');
const mqtt = require('mqtt');
const timers = require('timers');
const { CLOUD } = require('./constants');
const { PhilipsCloudApi } = require('./cloud-api');
const { DRINKS, profiles, savedRecipes } = require('./rita');

const NCP_PORT_MAP = Object.freeze({
  Status: 'airfryer',
  venusaf_s: 'airfryer',
  Config: 'config',
  Control: 'control',
  venusaf_c: 'control',
  recipe_c: 'recipe_control',
  devcurst_s: 'airfryer',
  firmware_s: 'firmware',
  devsett_s: 'firmware',
  recipe_s: 'recipe',
  acp_s: 'autocook',
  machinestatus: 'machinestatus',
  command: 'command',
  'command/BasicRecipe': 'basicrecipe',
  configuration: 'configuration',
  device: 'device',
});

const NCP_PROPERTY_MAP = Object.freeze({
  drw_opn: 'drawer_open',
  shk_rm_act: 'shake',
  prev_stat: 'prev_status',
  probe_unpl: 'probe_unplugged',
  probe_rqrd: 'probe_required',
  curr_temp: 'current_temp',
  cur_tmp_pr: 'current_temp_probe',
  versions: 'version',
  fw_update: 'upgrade',
  rec_cur_st: 'cur_stage',
});

const VENUS_TO_COMMON = Object.freeze({
  disp_time: 'cur_time',
  total_time: 'time',
  method: 'preset',
  current_temp: 'cur_temp',
});

const LOCAL_TO_NCP_PROPERTY = Object.fromEntries(Object.entries(NCP_PROPERTY_MAP).map(([key, value]) => [value, key]));
const COMMON_TO_VENUS = Object.fromEntries(Object.entries(VENUS_TO_COMMON).map(([key, value]) => [value, key]));

function delay(ms) {
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

class PhilipsFusionApi {
  constructor(config, logger = console) {
    this.config = {
      tenant: CLOUD.FUSION_TENANT,
      mqttHost: CLOUD.FUSION_MQTT_HOST,
      platformRestUrl: CLOUD.FUSION_PLATFORM_REST_URL,
      oauthClient: 'homeid',
      ...config,
    };
    this.log = logger;
    this.cloud = new PhilipsCloudApi(logger);
    this.client = null;
    this.connected = false;
    this.state = { powerOn: false, properties: {} };
    this.callback = null;
    this.connectionCallback = null;
    this.stateEmitTimer = null;
    this.readPorts = [];
    this.writePorts = [];
    this.portQueue = [];
    this.portInFlight = null;
    this.portTimer = null;
    this.portPumpTimer = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.reconnectFailures = 0;
    this.refreshTimer = null;
    this.accessToken = null;
    this.ritaCatalog = null;
    this.ritaCatalogFetched = false;
    this.ritaCatalogLoading = false;
    this.ritaCatalogRetryAt = 0;
    this.topics = this.createTopics();
  }

  createTopics() {
    const thing = this.config.thingName;
    const tenant = this.config.tenant;
    return {
      shadowGetAccepted: `$aws/things/${thing}/shadow/get/accepted`,
      shadowUpdateAccepted: `$aws/things/${thing}/shadow/update/accepted`,
      shadowGetRejected: `$aws/things/${thing}/shadow/get/rejected`,
      shadowUpdateRejected: `$aws/things/${thing}/shadow/update/rejected`,
      shadowUpdate: `$aws/things/${thing}/shadow/update`,
      shadowGet: `$aws/things/${thing}/shadow/get`,
      fromNcp: `${tenant}_ctrl/${thing}/from_ncp`,
      toNcp: `${tenant}_ctrl/${thing}/to_ncp`,
    };
  }

  onState(callback) {
    this.callback = callback;
  }

  onConnection(callback) {
    this.connectionCallback = callback;
  }

  emitState() {
    if (!this.stateEmitTimer) {
      this.stateEmitTimer = timers.setTimeout(() => {
        this.stateEmitTimer = null;
        if (!this.closed) this.callback?.(structuredClone(this.state));
      }, 100);
    }
    this.maybeFetchRitaCatalog();
  }

  ritaDrinks() {
    return this.ritaCatalog || DRINKS;
  }

  maybeFetchRitaCatalog() {
    if (this.closed || this.config.deviceType !== 'espresso' || !this.accessToken
      || !this.state.properties.Profiles || !this.state.properties.hostFirmwareVersion
      || !this.config.deviceId || this.ritaCatalogFetched || this.ritaCatalogLoading
      || Date.now() < this.ritaCatalogRetryAt) return;
    this.ritaCatalogLoading = true;
    this.fetchRitaCatalog().catch((error) => {
      this.log.error?.(`Rita drink catalog unavailable: ${error.message}`);
      this.ritaCatalogRetryAt = Date.now() + 300000;
    }).finally(() => { this.ritaCatalogLoading = false; });
  }

  async fetchRitaCatalog() {
    const registry = await this.cloud.getDevices(this.accessToken);
    const known = [this.config.deviceId, this.config.thingName, this.config.mac].filter(Boolean);
    const match = registry.find((item) => known.some((id) => [item.id, item.uuid, item.thingName, item.macAddress].includes(id)));
    const ctn = match?.ctn || this.config.model;
    if (!ctn) { this.ritaCatalogFetched = true; return; }
    const items = await this.cloud.getRitaCapabilities(
      this.accessToken, this.config.deviceId, ctn, String(this.state.properties.hostFirmwareVersion),
    );
    const catalog = {};
    for (const item of items) {
      const id = item?.drinkID;
      if (!Number.isInteger(id) || id <= 0 || id === 21 || !item?.drinkName?.trim()
        || !Array.isArray(item.ctnNumbers) || !item.ctnNumbers.includes(ctn)) continue;
      catalog[id] = item.drinkName.trim();
    }
    this.ritaCatalog = Object.keys(catalog).length ? catalog : null;
    this.ritaCatalogFetched = true;
    this.emitState();
  }

  async connect() {
    this.closed = false;
    const tokens = await this.cloud.refreshTokens(this.config.refreshToken, this.config.oauthClient);
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token && tokens.refresh_token !== this.config.refreshToken) {
      this.config.refreshToken = tokens.refresh_token;
      await this.config.onRefreshToken?.(tokens.refresh_token);
    }
    const [signatureResult, userId] = await Promise.all([
      this.cloud.getMqttSignature(tokens.access_token, this.config.platformRestUrl, this.config.tenant),
      this.cloud.getMqttUserId(
        tokens.access_token,
        tokens.id_token,
        this.config.platformRestUrl,
        this.config.tenant,
      ),
    ]);
    const signature = signatureResult.signature || signatureResult.mqttSignature;
    if (!signature || !userId) throw new Error('Philips cloud returned incomplete MQTT credentials');
    await this.openMqtt(tokens.access_token, signature, userId);
    this.scheduleTokenRefresh();
  }

  async openMqtt(accessToken, signature, userId) {
    timers.clearTimeout(this.portTimer);
    timers.clearTimeout(this.portPumpTimer);
    this.portInFlight = null;
    this.portQueue = [];
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
    }
    const clientId = `${userId}_${crypto.randomUUID()}`;
    const client = mqtt.connect(`wss://${this.config.mqttHost}/mqtt`, {
      port: 443,
      clientId,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: 30000,
      wsOptions: {
        headers: {
          'x-amz-customauthorizer-name': 'CustomAuthorizer',
          'x-amz-customauthorizer-signature': signature,
          'token-header': `Bearer ${accessToken}`,
          tenant: this.config.tenant,
          'content-type': 'application/json',
        },
      },
    });
    this.client = client;
    client.on('message', (topic, payload) => this.handleMessage(topic, payload));
    client.on('close', () => {
      if (client !== this.client) return;
      this.connected = false;
      timers.clearTimeout(this.portTimer);
      timers.clearTimeout(this.portPumpTimer);
      this.portTimer = null;
      this.portPumpTimer = null;
      this.portInFlight = null;
      this.portQueue = [];
      if (!this.closed) {
        Promise.resolve(this.connectionCallback?.(false)).catch((error) => {
          this.log.error?.(`MQTT connection status update failed: ${error.message}`);
        });
      }
      if (!this.closed) this.scheduleReconnect();
    });
    client.on('error', (error) => this.log.error?.(`Philips MQTT error: ${error.message}`));
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timeout);
          client.removeListener('connect', onConnect);
          client.removeListener('error', onError);
          if (error) reject(error);
          else resolve();
        };
        const timeout = timers.setTimeout(() => finish(new Error('MQTT connection timed out')), 30000);
        const onError = (error) => finish(error);
        const onConnect = () => {
          this.connected = true;
          const subscriptions = [
            this.topics.shadowGetAccepted,
            this.topics.shadowUpdateAccepted,
            this.topics.shadowGetRejected,
            this.topics.shadowUpdateRejected,
            this.topics.fromNcp,
          ];
          client.subscribe(subscriptions, { qos: 0 }, (error) => {
            if (error) { finish(error); return; }
            try {
              this.requestState();
              this.sendNcp('', 'getAllPorts');
              this.reconnectFailures = 0;
              Promise.resolve(this.connectionCallback?.(true)).catch((statusError) => {
                this.log.error?.(`MQTT connection status update failed: ${statusError.message}`);
              });
              finish();
            } catch (sendError) {
              finish(sendError);
            }
          });
        };
        client.once('connect', onConnect);
        client.once('error', onError);
      });
    } catch (error) {
      this.connected = false;
      client.end(true);
      this.scheduleReconnect();
      throw error;
    }
  }

  scheduleTokenRefresh() {
    timers.clearTimeout(this.refreshTimer);
    this.refreshTimer = timers.setTimeout(() => {
      this.connect().catch((error) => {
        this.log.error?.(`MQTT credential refresh failed: ${error.message}`);
        this.scheduleReconnect();
      });
    }, 50 * 60 * 1000);
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const retryDelay = Math.min(300000, 15000 * (2 ** Math.min(this.reconnectFailures, 5)));
    this.reconnectFailures += 1;
    this.reconnectTimer = timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.log.error?.(`MQTT reconnect failed: ${error.message}`);
        this.scheduleReconnect();
      });
    }, retryDelay);
  }

  close() {
    this.closed = true;
    this.accessToken = null;
    timers.clearTimeout(this.refreshTimer);
    timers.clearTimeout(this.reconnectTimer);
    timers.clearTimeout(this.stateEmitTimer);
    timers.clearTimeout(this.portTimer);
    timers.clearTimeout(this.portPumpTimer);
    this.stateEmitTimer = null;
    this.portTimer = null;
    this.portPumpTimer = null;
    this.portQueue = [];
    this.portInFlight = null;
    if (this.client) this.client.end(true);
    this.client = null;
    this.connected = false;
    this.cloud.close();
  }

  publish(topic, body, qos = 1) {
    if (!this.client || !this.connected) throw new Error('Philips MQTT is not connected');
    this.client.publish(topic, JSON.stringify(body), { qos });
  }

  requestState({ activeOnly = false } = {}) {
    this.publish(this.topics.shadowGet, {});
    const activePorts = this.readPorts.filter((port) => ['airfryer', 'machinestatus'].includes(NCP_PORT_MAP[port]));
    if (activeOnly && activePorts.length) this.queuePortReads(activePorts);
    else if (this.readPorts.length) this.queuePortReads(this.readPorts);
    else this.sendNcp('', 'getAllPorts');
  }

  sendNcp(portName, commandName = 'setPort', properties) {
    let data;
    if (portName) {
      const resolved = this.resolveNcpPort(portName);
      data = { portName: resolved };
      if (properties) data.properties = this.toNcpProperties(resolved, properties);
    }
    const cid = crypto.randomBytes(4).toString('hex');
    const payload = {
      cid,
      time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      type: 'command',
      cn: commandName,
      ct: 'mobile',
      ...(data ? { data } : {}),
    };
    this.publish(this.topics.toNcp, payload);
    return cid;
  }

  resolveNcpPort(localPort) {
    const all = [...this.readPorts, ...this.writePorts];
    return all.find((port) => NCP_PORT_MAP[port] === localPort)
      || Object.keys(NCP_PORT_MAP).find((port) => NCP_PORT_MAP[port] === localPort)
      || localPort;
  }

  toNcpProperties(ncpPort, properties) {
    let output = Object.fromEntries(Object.entries(properties).map(([key, value]) => [LOCAL_TO_NCP_PROPERTY[key] || key, value]));
    if (ncpPort === 'venusaf_c' || (this.isVenus() && ncpPort === 'Control')) {
      output = Object.fromEntries(Object.entries(output).map(([key, value]) => [COMMON_TO_VENUS[key] || key, value]));
    }
    return output;
  }

  isVenus() {
    return [...this.readPorts, ...this.writePorts].some((port) => ['venusaf_s', 'venusaf_c', 'devcurst_s'].includes(port));
  }

  queuePortReads(ports) {
    for (const port of ports) if (!this.portQueue.includes(port) && port !== this.portInFlight) this.portQueue.push(port);
    this.pumpPortQueue();
  }

  pumpPortQueue() {
    if (this.portInFlight || !this.portQueue.length || !this.connected) return;
    this.portInFlight = this.portQueue.shift();
    const port = this.portInFlight;
    try {
      this.sendNcp(port, 'getPort');
    } catch (error) {
      this.portInFlight = null;
      this.log.error?.(`Philips port read failed: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    timers.clearTimeout(this.portTimer);
    this.portTimer = timers.setTimeout(() => {
      this.portTimer = null;
      if (this.portInFlight === port) {
        this.portInFlight = null;
        this.pumpPortQueue();
      }
    }, 5500);
  }

  handleMessage(topic, buffer) {
    let payload;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      return;
    }
    if ([this.topics.shadowGetAccepted, this.topics.shadowUpdateAccepted].includes(topic)) {
      this.handleShadow(payload);
    } else if (topic === this.topics.fromNcp) {
      this.handleNcp(payload);
    }
  }

  handleShadow(payload) {
    const reported = payload.state?.reported || {};
    if (reported.powerOn !== undefined) this.state.powerOn = Boolean(reported.powerOn);
    for (const [key, value] of Object.entries(reported)) {
      if (key !== 'powerOn') this.state.properties[key] = value;
    }
    this.emitState();
  }

  handleNcp(payload) {
    if (payload.cn === 'getAllPorts' && payload.status === 0 && Array.isArray(payload.data)) {
      this.readPorts = payload.data.filter((port) => port.direction === 'read').map((port) => port.portName);
      this.writePorts = payload.data.filter((port) => port.direction === 'write').map((port) => port.portName);
      this.queuePortReads(this.readPorts);
      return;
    }
    if (payload.cn === 'getPort') {
      const responsePort = payload.data?.portName;
      if (responsePort && this.portInFlight && responsePort !== this.portInFlight) return;
      const wasBusy = payload.status === 1;
      const current = this.portInFlight;
      timers.clearTimeout(this.portTimer);
      this.portTimer = null;
      this.portInFlight = null;
      if (wasBusy && current) this.portQueue.push(current);
      timers.clearTimeout(this.portPumpTimer);
      this.portPumpTimer = timers.setTimeout(() => {
        this.portPumpTimer = null;
        this.pumpPortQueue();
      }, wasBusy ? 3000 : 1000);
    }
    if (payload.status !== undefined && payload.status !== 0) return;
    const ncpPort = payload.data?.portName;
    const rawProperties = payload.data?.properties;
    if (!ncpPort || !rawProperties || typeof rawProperties !== 'object') return;
    const properties = { ...rawProperties };
    for (const [wire, local] of Object.entries(NCP_PROPERTY_MAP)) {
      if (properties[wire] !== undefined && properties[local] === undefined) properties[local] = properties[wire];
    }
    const localPort = NCP_PORT_MAP[ncpPort] || ncpPort;
    if (localPort === 'airfryer' && this.isVenus()) {
      for (const [venus, common] of Object.entries(VENUS_TO_COMMON)) {
        if (properties[venus] !== undefined && properties[common] === undefined) properties[common] = properties[venus];
      }
    }
    if (this.config.deviceType === 'air_purifier' && ['Status', 'filtRd'].includes(ncpPort)) {
      Object.assign(this.state.properties, properties);
    } else {
      const existing = this.state.properties[localPort];
      this.state.properties[localPort] = existing && typeof existing === 'object'
        ? { ...existing, ...properties }
        : properties;
    }
    if (localPort === 'airfryer' && properties.status !== undefined) {
      this.state.powerOn = ['cooking', 'pause', 'setting', 'precook', 'parasetting', 'maintain', 'user_action', 'idle', 'finish'].includes(properties.status);
    }
    if (localPort === 'machinestatus' && properties.mainstate !== undefined
      && this.config.deviceType !== 'espresso') this.state.powerOn = Number(properties.mainstate) !== 0;
    this.emitState();
  }

  getFullState() {
    return structuredClone(this.state);
  }

  async setPower(type, enabled) {
    if (['airfryer', 'multicooker'].includes(type)) {
      if (enabled) {
        this.publish(this.topics.shadowUpdate, { state: { desired: { powerOn: true } } });
        await delay(1000);
        this.sendNcp('', 'getAllPorts');
      } else {
        this.sendNcp('control', 'setPort', { status: 'standby' });
      }
      return true;
    }
    this.publish(this.topics.shadowUpdate, { state: { desired: { powerOn: enabled } } });
    return true;
  }

  async setPurifierMode(mode) {
    const maps = {
      AC0650: { gentle: 1, sleep: 17, turbo: 18 },
      AC0651: { auto: 0, medium: 1, sleep: 17, turbo: 18 },
      AC1715: { auto: 0, medium: 1, fast: 2, sleep: 17, turbo: 18 },
    };
    const model = String(this.config.model).toUpperCase();
    const mapping = Object.entries(maps).find(([prefix]) => model.includes(prefix))?.[1] || maps.AC0651;
    if (mapping[mode] === undefined) throw new Error(`Unsupported purifier mode: ${mode}`);
    if (!this.state.powerOn) await this.setPower('air_purifier', true);
    this.sendNcp('control', 'setPort', { D0310C: mapping[mode] });
    return true;
  }

  async setChildLock(enabled) {
    this.sendNcp('status', 'setPort', { cl: enabled });
    return true;
  }

  async setPurifierSetting(field, value) {
    if (!['D03130', 'D0312C', 'D03134'].includes(field)) throw new Error('Unsupported purifier setting');
    const numeric = field === 'D03134' ? (value ? 1 : 0) : Number(value);
    if (!Number.isInteger(numeric) || (field === 'D03130' && (numeric < 0 || numeric > 3))
      || (field === 'D0312C' && (numeric < 1 || numeric > 4))) throw new Error('Invalid purifier setting');
    this.sendNcp('control', 'setPort', { [field]: numeric });
    return true;
  }

  async setCookingSettings({ temperature, durationSeconds, method, preheat, airspeed, probeTemperature }) {
    const properties = { status: this.isVenus() ? 'precook' : 'setting' };
    if (temperature !== undefined) properties.temp = temperature;
    if (durationSeconds !== undefined) properties.time = durationSeconds;
    if (method !== undefined) properties.preset = Number(method);
    if (preheat !== undefined) properties.preheat = Boolean(preheat);
    if (airspeed !== undefined) {
      if (!Number.isInteger(airspeed) || airspeed < 1 || airspeed > 2) throw new Error('Invalid airspeed');
      properties.airspeed = airspeed;
    }
    if (probeTemperature !== undefined) {
      if (!Number.isInteger(probeTemperature) || probeTemperature < 40 || probeTemperature > 100) throw new Error('Invalid probe temperature');
      properties.temp_probe = probeTemperature;
      properties.probe_required = true;
    }
    const currentUnit = this.state.properties.airfryer?.temp_unit;
    if (!this.isVenus() && currentUnit !== undefined && currentUnit !== null) properties.temp_unit = Boolean(currentUnit);
    this.sendNcp('control', 'setPort', properties);
    return true;
  }

  async startCooking(options = {}) {
    await this.setPower(this.config.deviceType, true);
    await this.setCookingSettings(options);
    await delay(500);
    this.sendNcp('control', 'setPort', { status: 'cooking' });
    return true;
  }

  async pauseCooking() {
    this.sendNcp('control', 'setPort', { status: 'pause' });
    return true;
  }

  async stopCooking() {
    this.sendNcp('control', 'setPort', { status: 'standby' });
    return true;
  }

  async keepWarm(durationSeconds = 3600) {
    const model = String(this.config.model || '').toUpperCase();
    const style = this.isVenus() || model.includes('NX0960') || model.includes('NX0950');
    const preset = model.includes('NX0960') ? 9 : model.includes('NX0950') ? 50 : style ? 2 : 8;
    const properties = style
      ? { time: durationSeconds, preset, status: 'maintain' }
      : { time: durationSeconds, temp: 65, preset, status: 'cooking' };
    const currentUnit = this.state.properties.airfryer?.temp_unit;
    if (!style && currentUnit !== undefined && currentUnit !== null) properties.temp_unit = Boolean(currentUnit);
    this.sendNcp('control', 'setPort', properties);
    return true;
  }

  ritaProfiles() {
    return profiles(this.state.properties);
  }

  ritaSavedRecipes(profileSlot) {
    return savedRecipes(this.state.properties, profileSlot, this.ritaDrinks());
  }

  ritaProfileId(slot) {
    const profile = this.ritaProfiles().find((item) => item.slot === Number(slot));
    if (!profile) throw new Error(`Profile ${slot} is not available on the machine`);
    return profile.id;
  }

  ritaSessionId(active = false) {
    const reported = Number(this.state.properties.airfryer?.SesOwnId);
    if (active && Number.isSafeInteger(reported) && reported > 0) return reported;
    return crypto.randomInt(10, 0x7fffffff);
  }

  ritaCommand(command, extra = {}, active = false) {
    if (this.config.deviceType !== 'espresso') throw new Error('Rita command requires an espresso machine');
    const sessionId = this.ritaSessionId(active);
    this.sendNcp('control', 'setPort', {
      CtrlCmd: command,
      SesOwnId: sessionId,
      ...extra,
    });
    if ([1, 2].includes(command)) this.lastBrewSessionId = sessionId;
    return true;
  }

  async brewBuiltin(profileSlot, drinkId) {
    const id = Number(drinkId);
    if (!Number.isInteger(id) || (!this.ritaDrinks()[id] && id !== 21)) throw new Error(`Unsupported drink: ${drinkId}`);
    return this.ritaCommand(1, { Profile_id: this.ritaProfileId(profileSlot), Recipe_id: id });
  }

  async brewSaved(profileSlot, recipeSlot) {
    const recipe = this.ritaSavedRecipes(Number(profileSlot)).find((item) => item.slot === Number(recipeSlot));
    if (!recipe) throw new Error(`Saved recipe ${recipeSlot} is not available in profile ${profileSlot}`);
    return this.ritaCommand(2, { Profile_id: this.ritaProfileId(profileSlot), RcpBinData: recipe.blob });
  }

  async abortBrew() { return this.ritaCommand(4, {}, true); }

  async resumeBrew() { return this.ritaCommand(5, {}, true); }

  async skipBrewStep() { return this.ritaCommand(3, {}, true); }

  async setRitaBeanOrRoast(field, value) {
    if (!['BeanType', 'RoastLevel'].includes(field) || ![0, 1, 2].includes(Number(value))) {
      throw new Error('Invalid bean or roast setting');
    }
    const state = this.state.properties.airfryer || {};
    const bean = field === 'BeanType' ? Number(value) : Number(state.BeanType);
    const roast = field === 'RoastLevel' ? Number(value) : Number(state.RoastLevel);
    if (![0, 1, 2].includes(bean) || ![0, 1, 2].includes(roast)) {
      throw new Error('Wait until current bean and roast settings have loaded');
    }
    return this.ritaCommand(14, { BeanType: bean, RoastLevel: roast });
  }

  async setBasicRecipeSetting(field, value) {
    const ranges = { GrDose: [0, 100], Temperature: [0, 100], NrOfBrews: [0, 4], PrimDose: [0, 500], SecDose: [0, 500] };
    const range = ranges[field];
    if (!range || !Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new Error('Invalid basic recipe setting');
    }
    if (!this.readPorts.includes('command/BasicRecipe') && !this.writePorts.includes('command/BasicRecipe')) {
      throw new Error('This espresso machine does not support basic recipe settings');
    }
    this.sendNcp('basicrecipe', 'setPort', { [field]: value });
    return true;
  }

  async brewDrink(drink, volume, profileSlot = 0) {
    const drinkIds = { espresso: 2, coffee: 7, hot_water: 21 };
    const drinkId = drinkIds[drink];
    if (!drinkId) throw new Error(`Unsupported drink: ${drink}`);
    const selected = this.ritaProfiles().find((profile) => profile.slot === Number(profileSlot))
      || this.ritaProfiles()[0];
    if (!selected) throw new Error('No usable espresso profile is available on the machine');
    return this.brewBuiltin(selected.slot, drinkId);
  }
}

module.exports = PhilipsFusionApi;
