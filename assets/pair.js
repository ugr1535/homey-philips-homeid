'use strict';

function page(title, body) {
  document.body.innerHTML = `
    <main class="homey-form">
      <h1 class="homey-title">${title}</h1>
      ${body}
      <p id="error" class="homey-form-error" style="display:none;color:#c00;margin-top:1rem"></p>
    </main>`;
}

function field(id, label, type = 'text', placeholder = '') {
  return `<div class="homey-form-group">
    <label class="homey-form-label" for="${id}">${label}</label>
    <input class="homey-form-input" id="${id}" type="${type}" placeholder="${placeholder}">
  </div>`;
}

function showError(error) {
  const node = document.getElementById('error');
  node.textContent = error?.message || String(error);
  node.style.display = 'block';
}

function busy(button, value) {
  button.disabled = value;
  button.classList.toggle('is-loading', value);
}

window.renderChoose = function renderChoose(Homey) {
  page(Homey.__('pair.choose'), `
    <button id="cloud" class="homey-button-primary-full">${Homey.__('pair.cloud')}</button>
    <button id="manual" class="homey-button-secondary-full" style="margin-top:1rem">${Homey.__('pair.manual')}</button>`);
  document.getElementById('cloud').onclick = () => Homey.showView('cloud_login');
  document.getElementById('manual').onclick = () => Homey.showView('manual');
  Homey.ready();
};

window.renderCloudLogin = function renderCloudLogin(Homey) {
  page(Homey.__('pair.cloud'), `
    ${field('email', Homey.__('pair.email'), 'email')}
    ${field('host', Homey.__('pair.host'), 'text', '192.168.1.50')}
    <p class="homey-subtitle">${Homey.__('pair.host_hint')}</p>
    <button id="submit" class="homey-button-primary-full">${Homey.__('pair.send_code')}</button>`);
  const button = document.getElementById('submit');
  button.onclick = async() => {
    try {
      busy(button, true);
      await Homey.emit('send_otp', {
        email: document.getElementById('email').value,
        host: document.getElementById('host').value,
      });
      await Homey.showView('cloud_otp');
    } catch (error) {
      showError(error);
      busy(button, false);
    }
  };
  Homey.ready();
};

window.renderCloudOtp = function renderCloudOtp(Homey) {
  page(Homey.__('pair.code'), `
    ${field('code', Homey.__('pair.code'), 'text', '123456')}
    <button id="submit" class="homey-button-primary-full">${Homey.__('pair.verify')}</button>`);
  const button = document.getElementById('submit');
  button.onclick = async() => {
    try {
      busy(button, true);
      await Homey.emit('verify_otp', { code: document.getElementById('code').value });
    } catch (error) {
      showError(error);
      busy(button, false);
    }
  };
  Homey.ready();
};

window.renderManual = function renderManual(Homey) {
  page(Homey.__('pair.manual'), `
    <div id="discovery" class="homey-form-group" style="display:none">
      <label class="homey-form-label" for="discovered">${Homey.__('pair.discovered')}</label>
      <select id="discovered" class="homey-form-select"></select>
    </div>
    ${field('name', Homey.__('pair.name'))}
    ${field('host', Homey.__('pair.host'), 'text', '192.168.1.50')}
    ${field('model', Homey.__('pair.model'), 'text', 'HD9280')}
    ${field('clientId', Homey.__('pair.client_id'))}
    ${field('clientSecret', Homey.__('pair.client_secret'), 'password')}
    ${field('encryptionKey', Homey.__('pair.encryption_key'), 'password')}
    <div class="homey-form-group"><label class="homey-form-checkbox">
      <input id="useHttp" type="checkbox"><span>${Homey.__('pair.use_http')}</span>
    </label></div>
    <button id="submit" class="homey-button-primary-full">${Homey.__('pair.add')}</button>`);
  const button = document.getElementById('submit');
  Homey.emit('get_discovered_devices').then((devices) => {
    if (!devices?.length) return;
    const wrapper = document.getElementById('discovery');
    const select = document.getElementById('discovered');
    select.innerHTML = `<option value="">${Homey.__('pair.select_discovered')}</option>`
      + devices.map((device, index) => `<option value="${index}">${device.name} (${device.host})</option>`).join('');
    select.onchange = () => {
      const device = devices[Number(select.value)];
      if (!device) return;
      document.getElementById('host').value = device.host;
      document.getElementById('model').value = device.model || '';
      document.getElementById('name').value = device.name || '';
      document.getElementById('useHttp').checked = Boolean(device.useHttp);
    };
    wrapper.style.display = 'block';
  }).catch(() => undefined);
  button.onclick = async() => {
    try {
      busy(button, true);
      const device = await Homey.emit('manual_setup', {
        name: document.getElementById('name').value,
        host: document.getElementById('host').value,
        model: document.getElementById('model').value,
        clientId: document.getElementById('clientId').value,
        clientSecret: document.getElementById('clientSecret').value,
        encryptionKey: document.getElementById('encryptionKey').value,
        useHttp: document.getElementById('useHttp').checked,
      });
      await Homey.createDevice(device);
      await Homey.done();
    } catch (error) {
      showError(error);
      busy(button, false);
    }
  };
  Homey.ready();
};
