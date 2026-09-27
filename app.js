'use strict';

const Homey = require('homey');

class PhilipsHomeIdApp extends Homey.App {
  async onInit() {
    this.registerAction('start_cooking', ({ device, temperature, duration, preheat }) => (
      device.startCooking({ temperature, durationMinutes: duration, preheat })
    ));
    this.registerAction('pause_cooking', ({ device }) => device.pauseCooking());
    this.registerAction('stop_cooking', ({ device }) => device.stopCooking());
    this.registerAction('keep_warm', ({ device, duration }) => device.keepWarm(duration));
    this.registerAction('set_cooking_method', ({ device, method }) => device.setCookingMethod(method));
    this.registerAction('brew_drink', ({ device, drink, volume }) => device.brewDrink(drink, volume));
    this.registerAction('brew_builtin_rita', ({ device, profile, drink }) => device.brewBuiltin(drink.id, profile.id));
    this.registerAction('brew_saved_rita', ({ device, profile, recipe }) => {
      if (Math.floor(Number(recipe.id) / 8) !== Number(profile.id)) throw new Error('Recipe belongs to another profile');
      return device.brewSaved(Number(recipe.id) % 8, profile.id);
    });
    this.registerAction('brew_hot_water_rita', ({ device }) => device.brewHotWater());
    this.registerAction('abort_brew_rita', ({ device }) => device.abortBrew());
    this.registerAction('resume_brew_rita', ({ device }) => device.resumeBrew());
    this.registerAction('skip_brew_step_rita', ({ device }) => device.skipBrewStep());
    this.registerAction('set_bean_type_rita', ({ device, bean }) => device.setBeanType(bean));
    this.registerAction('set_roast_level_rita', ({ device, roast }) => device.setRoastLevel(roast));
    for (const id of ['brew_builtin_rita', 'brew_saved_rita']) {
      this.homey.flow.getActionCard(id).registerArgumentAutocompleteListener('profile', (query, args) => (
        args.device?.api?.ritaProfiles?.().map((profile) => ({ id: String(profile.slot), name: profile.name }))
          .filter((profile) => profile.name.toLowerCase().includes(query.toLowerCase())) || []
      ));
    }
    this.homey.flow.getActionCard('brew_saved_rita').registerArgumentAutocompleteListener('recipe', (query, args) => (
      args.device?.api?.ritaSavedRecipes?.(Number(args.profile?.id)).map((recipe) => ({
        id: String(recipe.slot), name: recipe.name,
      })).filter((recipe) => recipe.name.toLowerCase().includes(query.toLowerCase())) || []
    ));
    this.homey.flow.getActionCard('brew_builtin_rita').registerArgumentAutocompleteListener('drink', (query, args) => (
      Object.entries(args.device?.api?.ritaDrinks?.() || {}).map(([id, name]) => ({ id, name }))
        .filter((drink) => drink.name.toLowerCase().includes(query.toLowerCase()))
    ));
    this.registerAction('refresh_device', ({ device }) => device.refreshNow());

    this.homey.flow.getConditionCard('is_cooking')
      .registerRunListener(({ device }) => device.isCooking());
    this.log('Philips HomeID app initialized');
  }

  registerAction(id, listener) {
    this.homey.flow.getActionCard(id).registerRunListener(listener);
  }
}

module.exports = PhilipsHomeIdApp;
