'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

class HttpError extends Error {
  constructor(message, status, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

class HttpClient {
  constructor({ timeout = 30000, insecure = false, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
    this.timeout = timeout;
    this.maxResponseBytes = maxResponseBytes;
    this.cookies = new Map();
    this.httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: !insecure });
    this.httpAgent = new http.Agent({ keepAlive: true });
  }

  close() {
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
  }

  async request(url, options = {}) {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    let payload;
    if (options.form) {
      payload = new URLSearchParams(options.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (options.json !== undefined) {
      payload = JSON.stringify(options.json);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    } else if (options.body !== undefined) {
      payload = String(options.body);
    }
    if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);
    const matchingCookies = [...this.cookies.values()].filter((cookie) => {
      const domainMatches = target.hostname === cookie.domain
        || target.hostname.endsWith(`.${cookie.domain}`);
      const pathMatches = target.pathname.startsWith(cookie.path);
      return domainMatches && pathMatches && (!cookie.secure || target.protocol === 'https:');
    });
    if (matchingCookies.length) {
      headers.Cookie = matchingCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }

    return new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method,
        headers,
        agent: target.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
      }, (response) => {
        const chunks = [];
        let totalBytes = 0;
        response.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > this.maxResponseBytes) {
            response.destroy(new Error('Philips response exceeded the memory safety limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const setCookies = response.headers['set-cookie'] || [];
          for (const cookie of setCookies) {
            const [pair, ...attributes] = cookie.split(';');
            const separator = pair.indexOf('=');
            if (separator <= 0) continue;
            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            const parsed = {
              name,
              value,
              domain: target.hostname.toLowerCase(),
              path: '/',
              secure: false,
            };
            for (const attribute of attributes) {
              const [rawKey, ...rawValue] = attribute.trim().split('=');
              const key = rawKey.toLowerCase();
              const attributeValue = rawValue.join('=').trim();
              if (key === 'domain' && attributeValue) parsed.domain = attributeValue.replace(/^\./, '').toLowerCase();
              if (key === 'path' && attributeValue) parsed.path = attributeValue;
              if (key === 'secure') parsed.secure = true;
            }
            const cookieKey = `${parsed.domain}|${parsed.path}|${name}`;
            if (!value || attributes.some((attribute) => /^max-age=0$/i.test(attribute.trim()))) {
              this.cookies.delete(cookieKey);
            } else {
              this.cookies.set(cookieKey, parsed);
            }
          }
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode || 0, headers: response.headers, body });
        });
      });
      request.setTimeout(options.timeout || this.timeout, () => {
        request.destroy(new Error(`Request timed out after ${options.timeout || this.timeout} ms`));
      });
      request.on('error', reject);
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }

  async json(url, options = {}) {
    const response = await this.request(url, options);
    let data;
    try {
      data = response.body ? JSON.parse(response.body) : {};
    } catch (error) {
      throw new HttpError(`Endpoint returned invalid JSON (HTTP ${response.status})`, response.status);
    }
    return { ...response, data };
  }
}

module.exports = { HttpClient, HttpError };
