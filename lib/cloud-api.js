'use strict';

const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');
const { CLOUD, normalizeId } = require('./constants');
const { HttpClient } = require('./http-client');

const HOMEID_SCOPES = [
  'openid', 'profile', 'email', 'offline_access', 'DI.Account.read',
  'DI.AccountProfile.read', 'DI.AccountProfile.write', 'DI.AccountGeneralConsent.read',
  'DI.AccountGeneralConsent.write', 'DI.GeneralConsent.read', 'DI.GeneralConsent.write',
  'VoiceProvider.read', 'VoiceProvider.write', 'subscriptions', 'consent',
  'profile_extended', 'DI.AccountSubscription.write', 'DI.AccountSubscription.read',
].join(' ');

const AIRPLUS_SCOPES = [
  'openid', 'email', 'profile', 'address', 'DI.Account.read', 'DI.Account.write',
  'DI.AccountProfile.read', 'DI.AccountProfile.write', 'DI.AccountGeneralConsent.read',
  'DI.AccountGeneralConsent.write', 'DI.GeneralConsent.read', 'subscriptions',
  'profile_extended', 'consents', 'DI.AccountSubscription.read',
  'DI.AccountSubscription.write',
].join(' ');

const OAUTH_CLIENTS = Object.freeze({
  homeid: {
    id: CLOUD.OAUTH_CLIENT_ID,
    redirect: CLOUD.MOBILE_REDIRECT_URI,
    scopes: HOMEID_SCOPES,
  },
  airplus: {
    id: CLOUD.AIRPLUS_CLIENT_ID,
    redirect: CLOUD.AIRPLUS_REDIRECT_URI,
    scopes: AIRPLUS_SCOPES,
  },
});

const OIDC_ISSUER = `${CLOUD.GIGYA_API_URL}/oidc/op/v1.0/${CLOUD.GIGYA_API_KEY}`;
const OIDC_AUTHORIZE = `${OIDC_ISSUER}/authorize`;
const OIDC_TOKEN = `${OIDC_ISSUER}/token`;

class CloudAuthError extends Error {}
class CloudConnectionError extends Error {}

function parseJsonBody(response, endpoint) {
  try {
    return response.body ? JSON.parse(response.body) : {};
  } catch (error) {
    throw new CloudConnectionError(`${endpoint} returned invalid JSON (HTTP ${response.status})`);
  }
}

class PhilipsCloudApi {
  constructor(logger = console) {
    this.log = logger;
    this.client = new HttpClient({ timeout: 30000 });
  }

  close() {
    this.client.close();
  }

  async requestOtp(email) {
    const response = await this.client.request(`${CLOUD.GIGYA_API_URL}/accounts.auth.otp.email.sendCode`, {
      method: 'POST',
      form: { email, apiKey: CLOUD.GIGYA_API_KEY, format: 'json' },
    });
    const data = parseJsonBody(response, 'OTP endpoint');
    if (response.status >= 500) throw new CloudConnectionError(`OTP endpoint failed: HTTP ${response.status}`);
    if (data.errorCode !== 0) throw new CloudAuthError(data.errorMessage || 'OTP request failed');
    if (!data.vToken) throw new CloudAuthError('OTP endpoint returned no verification token');
    return data.vToken;
  }

  async verifyOtp(email, code, verificationToken) {
    const response = await this.client.request(`${CLOUD.GIGYA_API_URL}/accounts.auth.otp.email.login`, {
      method: 'POST',
      form: {
        email,
        code,
        vToken: verificationToken,
        apiKey: CLOUD.GIGYA_API_KEY,
        format: 'json',
      },
    });
    const data = parseJsonBody(response, 'OTP verification endpoint');
    if (response.status >= 500) throw new CloudConnectionError(`OTP verification failed: HTTP ${response.status}`);
    if (data.errorCode === 206001) {
      throw new CloudAuthError('The account registration is incomplete. Sign in once in the Philips HomeID app.');
    }
    if (data.errorCode !== 0) throw new CloudAuthError(data.errorMessage || 'Invalid verification code');
    const sessionToken = data.sessionInfo?.cookieValue;
    if (!sessionToken) throw new CloudAuthError('OTP verification returned no session token');
    return sessionToken;
  }

  async getOidcTokens(sessionToken, clientName = 'homeid') {
    const client = OAUTH_CLIENTS[clientName] || OAUTH_CLIENTS.homeid;
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const authUrl = new URL(OIDC_AUTHORIZE);
    authUrl.search = new URLSearchParams({
      client_id: client.id,
      response_type: 'code',
      redirect_uri: client.redirect,
      scope: client.scopes,
      state: crypto.randomBytes(16).toString('base64url'),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'none',
    }).toString();

    const authorize = await this.client.request(authUrl.toString());
    if (![301, 302, 303, 307, 308].includes(authorize.status)) {
      throw new CloudAuthError(`/authorize expected a redirect, got HTTP ${authorize.status}`);
    }
    const location = new URL(authorize.headers.location, OIDC_AUTHORIZE);
    const context = location.searchParams.get('context');
    if (!context) throw new CloudAuthError('/authorize returned no context');

    const idsResponse = await this.client.request(`${CLOUD.GIGYA_API_URL}/socialize.getIDs`, {
      method: 'POST',
      form: { APIKey: CLOUD.GIGYA_API_KEY, includeTicket: 'true', format: 'json' },
    });
    const ids = parseJsonBody(idsResponse, 'Gigya ID endpoint');
    if (!ids.gmidTicket) throw new CloudAuthError(ids.errorMessage || 'Gigya returned no login ticket');

    const continueUrl = new URL(`${OIDC_ISSUER}/authorize/continue`);
    continueUrl.search = new URLSearchParams({
      context,
      login_token: sessionToken,
      gmidTicket: ids.gmidTicket,
      client_id: client.id,
    }).toString();
    const continued = await this.client.request(continueUrl.toString());
    if (![301, 302, 303, 307, 308].includes(continued.status)) {
      throw new CloudAuthError(`/authorize/continue expected a redirect, got HTTP ${continued.status}`);
    }
    const callback = new URL(continued.headers.location, client.redirect);
    if (callback.searchParams.get('errorMessage')) throw new CloudAuthError(callback.searchParams.get('errorMessage'));
    const code = callback.searchParams.get('code');
    if (!code) throw new CloudAuthError('/authorize/continue returned no authorization code');

    return this.exchangeCode(code, codeVerifier, clientName);
  }

  async exchangeCode(code, codeVerifier, clientName = 'homeid') {
    const client = OAUTH_CLIENTS[clientName] || OAUTH_CLIENTS.homeid;
    const response = await this.client.request(OIDC_TOKEN, {
      method: 'POST',
      form: {
        client_id: client.id,
        grant_type: 'authorization_code',
        code,
        redirect_uri: client.redirect,
        code_verifier: codeVerifier,
      },
    });
    const data = parseJsonBody(response, 'Token endpoint');
    if (!data.access_token) {
      const message = data.error_description || data.error || `HTTP ${response.status}`;
      if (response.status === 401 || ['invalid_grant', 'invalid_token'].includes(data.error)) {
        throw new CloudAuthError(`Token exchange rejected: ${message}`);
      }
      throw new CloudConnectionError(`Token exchange failed: ${message}`);
    }
    return data;
  }

  async refreshTokens(refreshToken, clientName = 'homeid') {
    const client = OAUTH_CLIENTS[clientName] || OAUTH_CLIENTS.homeid;
    const response = await this.client.request(OIDC_TOKEN, {
      method: 'POST',
      form: { client_id: client.id, grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    const data = parseJsonBody(response, 'Token endpoint');
    if (data.access_token) return data;
    const message = data.error_description || data.error || `HTTP ${response.status}`;
    if (response.status === 401 || ['invalid_grant', 'invalid_token'].includes(data.error)) {
      throw new CloudAuthError(`Token refresh rejected: ${message}`);
    }
    throw new CloudConnectionError(`Token refresh failed: ${message}`);
  }

  async getHomeIdAppliances(tokens) {
    const discovery = await this.client.json(`${CLOUD.BACKEND_BASE}/.well-known/tenant/oneka`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Homey Philips HomeID',
      },
    });
    if (discovery.status !== 200) throw new CloudConnectionError(`HomeID discovery failed: HTTP ${discovery.status}`);
    let profileUrl = discovery.data.profileUrl;
    if (!profileUrl) return [];
    if (profileUrl.startsWith('/')) profileUrl = `${CLOUD.BACKEND_API_BASE}${profileUrl}`;
    const headers = this.homeIdHeaders(tokens.access_token);
    const profileResponse = await this.client.request(`${profileUrl}?ts=${Date.now()}`, { headers });
    const profile = parseJsonBody(profileResponse, 'HomeID profile');
    if (profileResponse.status === 401 || profileResponse.status === 403) throw new CloudAuthError('HomeID profile rejected the access token');
    if (profileResponse.status !== 200) throw new CloudConnectionError(`HomeID profile failed: HTTP ${profileResponse.status}`);
    const embeddedItems = profile._embedded?.userAppliances?._embedded?.item;
    if (Array.isArray(embeddedItems) && embeddedItems.length) return embeddedItems;
    let appliancesUrl = profile._links?.userAppliances?.href;
    if (!appliancesUrl) return [];
    if (appliancesUrl.startsWith('/')) appliancesUrl = `${CLOUD.BACKEND_API_BASE}${appliancesUrl}`;
    appliancesUrl = appliancesUrl.replace(/\{[^}]*\}/g, '');
    const separator = appliancesUrl.includes('?') ? '&' : '?';
    const response = await this.client.request(`${appliancesUrl}${separator}ts=${Date.now()}&includeSkippedPairing=true`, { headers });
    const data = parseJsonBody(response, 'HomeID appliances');
    if (response.status === 401 || response.status === 403) throw new CloudAuthError('HomeID appliances rejected the access token');
    if (response.status !== 200) throw new CloudConnectionError(`HomeID appliances failed: HTTP ${response.status}`);
    if (Array.isArray(data)) return data;
    return data._embedded?.item || [];
  }

  homeIdHeaders(accessToken) {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: CLOUD.HOMEID_ACCEPT,
      'Accept-Language': 'en-GB',
      'User-Agent': 'HomeID/8.16.0 (com.philips.ka.oneka.app; build:8160001; Android 14)',
      'X-USER-AGENT': 'Android 14;8.16.0',
    };
  }

  async getDevices(accessToken) {
    const response = await this.client.request(`${CLOUD.IOT_BASE}/user/self/device`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const data = parseJsonBody(response, 'IoT device registry');
    if ([401, 403].includes(response.status)) throw new CloudAuthError(`Device registry rejected token: HTTP ${response.status}`);
    if (response.status !== 200) throw new CloudConnectionError(`Device registry failed: HTTP ${response.status}`);
    if (Array.isArray(data)) return data;
    return data.devices || data.data || data.items || [];
  }

  async getRitaCapabilities(accessToken, deviceId, ctn, firmwareVersion) {
    const url = new URL(`${CLOUD.IOT_BASE}/device/${encodeURIComponent(deviceId)}/capabilities`);
    url.search = new URLSearchParams({ proposition: ctn, version: firmwareVersion }).toString();
    const response = await this.client.request(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if ([401, 403].includes(response.status)) throw new CloudAuthError('Rita capabilities rejected the access token');
    if (response.status !== 200) throw new CloudConnectionError(`Rita capabilities failed: HTTP ${response.status}`);
    const data = parseJsonBody(response, 'Rita capabilities');
    return Array.isArray(data) ? data : [];
  }

  async getDeviceCredentials(accessToken, deviceIds, ctns = []) {
    const query = ctns.map((ctn) => `ctn=${encodeURIComponent(ctn)}`).join('&');
    const response = await this.client.request(`${CLOUD.IOT_BASE}/user/self/device-migration?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      json: { sourceAppId: 'com.philips.ka.oneka.app', deviceIds },
    });
    if (response.status !== 200) return [];
    const data = parseJsonBody(response, 'Device migration');
    const devices = Array.isArray(data) ? data : data.devices || [];
    return devices.map((device) => {
      try {
        return { ...device, parsedCredentials: JSON.parse(device.localCredentials || '{}') };
      } catch (error) {
        return device;
      }
    });
  }

  async getMqttSignature(accessToken, platform = CLOUD.FUSION_PLATFORM_REST_URL, tenant = CLOUD.FUSION_TENANT) {
    const response = await this.client.request(`https://${platform}/api/${tenant}/user/self/signature`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (response.status === 401) throw new CloudAuthError('MQTT signature rejected the access token');
    if (response.status !== 200) throw new CloudConnectionError(`MQTT signature failed: HTTP ${response.status}`);
    return parseJsonBody(response, 'MQTT signature');
  }

  async getMqttUserId(accessToken, idToken, platform = CLOUD.FUSION_PLATFORM_REST_URL, tenant = CLOUD.FUSION_TENANT) {
    const response = await this.client.request(`https://${platform}/api/${tenant}/user/self/get-id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      json: { idToken },
    });
    if ([401, 403].includes(response.status)) throw new CloudAuthError('MQTT user ID request rejected the access token');
    if (response.status !== 200) throw new CloudConnectionError(`MQTT user ID failed: HTTP ${response.status}`);
    return parseJsonBody(response, 'MQTT user ID').userId;
  }

  async discover(sessionToken, { includeAirPlus = true } = {}) {
    const homeIdTokens = await this.getOidcTokens(sessionToken, 'homeid');
    const [applianceResult, registryResult] = await Promise.allSettled([
      this.getHomeIdAppliances(homeIdTokens),
      this.getDevices(homeIdTokens.access_token),
    ]);
    const appliances = applianceResult.status === 'fulfilled' ? applianceResult.value : [];
    const registry = registryResult.status === 'fulfilled' ? registryResult.value : [];
    if (applianceResult.status === 'rejected') {
      this.log.debug?.(`HomeID appliance lookup failed: ${applianceResult.reason.message}`);
    }
    if (registryResult.status === 'rejected') {
      this.log.debug?.(`HomeID device registry lookup failed: ${registryResult.reason.message}`);
    }
    const devices = this.mergeCloudDevices(appliances, registry, homeIdTokens, 'homeid');
    if (devices.length) return devices;
    if (!includeAirPlus) return [];

    try {
      const airPlusTokens = await this.getOidcTokens(sessionToken, 'airplus');
      const airPlus = await this.getDevices(airPlusTokens.access_token);
      return this.mergeCloudDevices([], airPlus, airPlusTokens, 'airplus');
    } catch (error) {
      this.log.debug?.(`Air+ lookup failed: ${error.message}`);
      return [];
    }
  }

  mergeCloudDevices(appliances, registry, tokens, oauthClient) {
    const registryById = new Map();
    const consumedRegistry = new Set();
    for (const entry of registry) {
      for (const value of [entry.id, entry.uuid, entry.macAddress]) {
        if (value) registryById.set(normalizeId(value), entry);
      }
    }
    const results = [];
    for (const appliance of appliances) {
      const externalId = appliance.externalDeviceId || '';
      const mac = appliance.macAddress || '';
      const registryDevice = registryById.get(normalizeId(externalId))
        || registryById.get(normalizeId(mac))
        || {};
      if (Object.keys(registryDevice).length) consumedRegistry.add(registryDevice);
      const model = appliance.modelNumber || appliance.model || appliance.ctn
        || registryDevice.ctn || appliance.name || '';
      const base = {
        id: normalizeId(mac || externalId || appliance.id || appliance.name),
        name: appliance.name || registryDevice.friendlyName || model || 'Philips HomeID',
        model,
        mac,
      };
      if (appliance.clientId && appliance.clientSecret) {
        results.push({
          ...base,
          connection: 'local',
          clientId: appliance.clientId,
          clientSecret: appliance.clientSecret,
          encryptionKey: appliance.encryptionKey || '',
          ...(externalId && registryDevice.thingName
            ? {
                fusionFallback: this.fusionDescriptor({
                  ...base,
                  thingName: registryDevice.thingName,
                  deviceId: externalId,
                  tokens,
                  oauthClient,
                }),
              }
            : {}),
        });
      } else if (externalId) {
        const thingName = registryDevice.thingName || (oauthClient === 'airplus' ? `da-${externalId}` : '');
        if (thingName) {
          results.push(this.fusionDescriptor({
            ...base, thingName, deviceId: externalId, tokens, oauthClient,
          }));
        }
      }
    }
    for (const entry of registry) {
      if (consumedRegistry.has(entry)) continue;
      const unique = normalizeId(entry.macAddress || entry.id || entry.uuid || entry.thingName);
      if (!unique || results.some((item) => item.id === unique)) continue;
      let parsedCredentials = {};
      try {
        parsedCredentials = JSON.parse(entry.localCredentials || '{}');
      } catch (error) {
        parsedCredentials = {};
      }
      const model = entry.ctn || entry.modelNumber || entry.friendlyName || '';
      if (parsedCredentials.client_id && parsedCredentials.client_secret) {
        results.push({
          id: unique,
          name: entry.friendlyName || entry.name || model || 'Philips HomeID',
          model,
          mac: entry.macAddress || '',
          connection: 'local',
          clientId: parsedCredentials.client_id,
          clientSecret: parsedCredentials.client_secret,
          encryptionKey: parsedCredentials.encryption_key || '',
        });
      } else {
        const deviceId = entry.uuid || entry.id || '';
        const thingName = entry.thingName || (deviceId ? `da-${deviceId}` : '');
        if (thingName) {
          results.push(this.fusionDescriptor({
            id: unique,
            name: entry.friendlyName || entry.name || model || 'Philips HomeID',
            model,
            mac: entry.macAddress || '',
            thingName,
            deviceId,
            tokens,
            oauthClient,
          }));
        }
      }
    }
    return results;
  }

  fusionDescriptor(data) {
    return {
      id: data.id,
      name: data.name,
      model: data.model,
      mac: data.mac,
      connection: 'fusion',
      thingName: data.thingName,
      deviceId: data.deviceId,
      refreshToken: data.tokens.refresh_token,
      oauthClient: data.oauthClient,
      tenant: CLOUD.FUSION_TENANT,
      mqttHost: CLOUD.FUSION_MQTT_HOST,
      platformRestUrl: CLOUD.FUSION_PLATFORM_REST_URL,
    };
  }
}

module.exports = {
  CloudAuthError,
  CloudConnectionError,
  PhilipsCloudApi,
};
