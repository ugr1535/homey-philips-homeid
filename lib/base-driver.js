'use strict';

const Homey = require('homey');
const { deviceTypeForModel, normalizeId } = require('./constants');
const { CloudConnectionError, PhilipsCloudApi } = require('./cloud-api');
const PhilipsLocalApi = require('./local-api');

class PhilipsHomeIdDriver extends Homey.Driver {
  async onPair(session) {
    const state = {
      cloud: null,
      verificationToken: null,
      sessionToken: null,
      host: '',
      devices: [],
    };
    this.recordPairingStage('pair_open');

    session.setHandler('send_otp', async({ email, host = '' }) => {
      this.recordPairingStage('send_otp_start');
      state.cloud?.close();
      state.cloud = new PhilipsCloudApi(this);
      state.verificationToken = null;
      state.sessionToken = null;
      state.devices = [];
      state.host = this.sanitizeHost(host);
      try {
        state.verificationToken = await state.cloud.requestOtp(String(email).trim());
      } catch (error) {
        this.recordPairingStage('send_otp_error');
        throw error;
      }
      state.email = String(email).trim();
      this.recordPairingStage('send_otp_ok');
      return true;
    });

    const verifyCode = async(code) => {
      this.recordPairingStage('verify_start');
      state.sessionToken = null;
      state.devices = [];
      if (!state.cloud || !state.verificationToken) {
        this.recordPairingStage('verify_missing_state');
        throw new Error('Request a verification code first');
      }
      try {
        state.sessionToken = await state.cloud.verifyOtp(state.email, String(code).trim(), state.verificationToken);
      } catch (error) {
        this.recordPairingStage('verify_error');
        throw error;
      }
      this.recordPairingStage('verify_ok');
    };

    const discoverDevices = async() => {
      if (!state.sessionToken) throw new Error('Verify the code first');
      if (state.devices.length) return state.devices;
      let discovered;
      try {
        discovered = await state.cloud.discover(state.sessionToken, {
          includeAirPlus: this.id === 'air_purifier',
        });
      } catch (error) {
        this.recordPairingStage('discover_error');
        throw error;
      }
      this.recordPairingStage('discover_ok', discovered.length);
      const descriptors = discovered
        .map((device) => (!state.host && device.connection === 'local' && device.fusionFallback
          ? device.fusionFallback
          : device))
        .filter((device) => deviceTypeForModel(device.model || device.name) === this.id)
        .filter((device) => device.connection === 'fusion' || Boolean(state.host))
        .map((device) => this.deviceDescriptor({ ...device, host: state.host }));
      state.devices = [...new Map(descriptors.map((device) => [device.data.id, device])).values()];
      this.recordPairingStage('matched', state.devices.length);
      this.log(`Cloud pairing matched ${state.devices.length} ${this.id} device(s)`);
      if (!state.devices.length) {
        throw new Error(state.host
          ? 'No compatible appliance was found for this device category'
          : 'No compatible cloud device was found. Local devices also require an IP address.');
      }
      this.recordPairingStage('verify_return');
      return state.devices;
    };
    session.setHandler('verify_otp', async({ code }) => {
      await verifyCode(code);
      return discoverDevices();
    });
    session.setHandler('pincode', async(digits) => {
      if (!Array.isArray(digits) || digits.length !== 6 || digits.some((digit) => !/^\d$/.test(digit))) return false;
      try {
        await verifyCode(digits.join(''));
        return true;
      } catch (error) {
        this.recordPairingStage('pincode_rejected');
        if (error instanceof CloudConnectionError) throw error;
        return false;
      }
    });
    session.setHandler('get_verified_devices', discoverDevices);

    session.setHandler('pair_progress', async({ stage }) => {
      if (['ui_ready', 'ui_verify_click', 'ui_received_devices', 'ui_create_start', 'ui_create_ok', 'ui_create_error', 'ui_done'].includes(stage)) {
        this.recordPairingStage(stage);
      }
      return true;
    });

    session.setHandler('get_discovered_devices', async() => this.getDiscoveredDevices());

    session.setHandler('manual_setup', async(input) => {
      const host = this.sanitizeHost(input.host);
      const config = {
        connection: 'local',
        host,
        model: String(input.model || '').trim(),
        clientId: String(input.clientId || '').trim(),
        clientSecret: String(input.clientSecret || '').trim(),
        encryptionKey: String(input.encryptionKey || '').trim(),
        useHttps: !input.useHttp,
      };
      if (!host || !config.clientId || !config.clientSecret) throw new Error('IP address, client ID and client secret are required');
      const api = new PhilipsLocalApi(config, this);
      try {
        const probe = await api.probe();
        config.useHttps = probe.useHttps;
        if (!config.encryptionKey && !config.useHttps) {
          try {
            config.encryptionKey = await api.exchangeEncryptionKey();
          } catch (error) {
            this.log(`Encryption key exchange unavailable: ${error.message}`);
          }
        }
        await api.getFullState(this.id);
      } finally {
        api.close();
      }
      return this.deviceDescriptor({
        ...config,
        id: normalizeId(input.id || probeIdentity(host, config.model)),
        name: String(input.name || config.model || `Philips ${this.id}`).trim(),
      });
    });

    session.setHandler('disconnect', async() => {
      state.cloud?.close();
    });
  }

  recordPairingStage(stage, count) {
    try {
      const settings = this.homey?.settings;
      if (!settings) return;
      const previous = settings.get('pairingDiagnostics');
      const events = Array.isArray(previous) ? previous.slice(-39) : [];
      const entry = { time: new Date().toISOString(), version: '0.1.28', driver: this.id, stage };
      if (Number.isInteger(count) && count >= 0) entry.count = count;
      events.push(entry);
      settings.set('pairingDiagnostics', events);
    } catch (error) {
      // Diagnostics must never interrupt pairing or expose account credentials.
    }
  }

  deviceDescriptor(device) {
    const deviceType = this.id;
    const uniqueId = normalizeId(device.id || device.mac || device.deviceId || device.thingName || device.host);
    const store = {
      connection: device.connection,
      deviceType,
      model: device.model || '',
      host: device.host || '',
      useHttps: device.useHttps !== false,
    };
    if (device.connection === 'local') {
      Object.assign(store, {
        clientId: device.clientId,
        clientSecret: device.clientSecret,
        encryptionKey: device.encryptionKey || '',
      });
    } else {
      Object.assign(store, {
        thingName: device.thingName,
        deviceId: device.deviceId,
        refreshToken: device.refreshToken,
        oauthClient: device.oauthClient,
        tenant: device.tenant,
        mqttHost: device.mqttHost,
        platformRestUrl: device.platformRestUrl,
      });
    }
    let capabilities;
    if (deviceType === 'espresso') {
      if (device.connection === 'fusion') {
        capabilities = [
          'onoff', 'homeid_machine_state', 'homeid_machine_status', 'homeid_machine_alert',
          'homeid_control_status', 'homeid_bean_type', 'homeid_roast_level',
          'homeid_aquaclean_filter_number', 'homeid_aquaclean_autonomy',
          'homeid_descale_autonomy', 'homeid_coffee_autonomy',
          'homeid_brew_group_autonomy',
        ];
      } else {
        capabilities = [
          'onoff', 'homeid_machine_state', 'homeid_brew_progress',
          'homeid_water_level', 'homeid_bean_level',
        ];
      }
    }
    return {
      name: String(device.name || device.model || 'Philips HomeID'),
      data: { id: uniqueId },
      ...(deviceType === 'espresso' ? { icon: '/icon.svg' } : {}),
      ...(capabilities ? { capabilities } : {}),
      store,
      settings: {
        host: device.host || '',
        model: device.model || '',
        connection: device.connection,
        poll_interval: 60,
        active_poll_interval: 10,
      },
    };
  }

  sanitizeHost(host = '') {
    const value = String(host).trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!value) return '';
    if (!/^(\[[0-9a-f:]+\]|[0-9a-f:]+|[a-z0-9.-]+)$/i.test(value)) throw new Error('Invalid IP address or host name');
    return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  }

  async getDiscoveredDevices() {
    const found = new Map();
    for (const strategyId of ['philips-condor', 'philips-http', 'philips-ssdp']) {
      try {
        const strategy = this.homey.discovery.getStrategy(strategyId);
        const results = Object.values(strategy.getDiscoveryResults());
        for (const result of results) {
          const location = result.headers?.location;
          let locationHost = '';
          try {
            locationHost = location ? new URL(location).hostname : '';
          } catch (error) {
            locationHost = '';
          }
          const host = result.address || locationHost;
          const model = result.txt?.mn
            || result.txt?.mr
            || result.headers?.['model-name']
            || String(result.name || '').split('_')[1]
            || '';
          if (!host || deviceTypeForModel(model || result.name) !== this.id) continue;
          found.set(host, {
            host,
            model,
            name: result.txt?.fn || result.name || model || host,
            useHttp: strategyId === 'philips-http',
          });
        }
      } catch (error) {
        this.log(`Discovery strategy ${strategyId} unavailable: ${error.message}`);
      }
    }
    return [...found.values()];
  }
}

function probeIdentity(host, model) {
  return `${model || 'philips'}-${host}`;
}

module.exports = PhilipsHomeIdDriver;
