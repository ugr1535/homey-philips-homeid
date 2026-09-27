'use strict';

function espressoDevice(homey, deviceId) {
  const devices = homey.drivers.getDriver('espresso').getDevices();
  const device = devices.find((candidate) => candidate.getId() === deviceId);
  if (!device) throw new Error('Espresso machine not found');
  return device;
}

module.exports = {
  async getStatus({ homey, params }) {
    return espressoDevice(homey, params.deviceId).getWidgetStatus();
  },

  async getBrewMenu({ homey, params }) {
    return espressoDevice(homey, params.deviceId).getWidgetBrewMenu();
  },

  async setPower({ homey, params, body }) {
    if (typeof body?.enabled !== 'boolean') throw new Error('Choose a valid power state');
    await espressoDevice(homey, params.deviceId).setWidgetPower(body.enabled);
    return { sent: true };
  },

  async brewSaved({ homey, params, body }) {
    const profileSlot = Number(body?.profileSlot);
    const recipeSlot = Number(body?.recipeSlot);
    if (!Number.isInteger(profileSlot) || !Number.isInteger(recipeSlot)
      || body?.profileSlot === null || body?.recipeSlot === null
      || body?.profileSlot === '' || body?.recipeSlot === '') {
      throw new Error('Choose a valid profile and saved recipe');
    }
    await espressoDevice(homey, params.deviceId).brewSavedFromWidget(profileSlot, recipeSlot);
    return { sent: true };
  },
};
