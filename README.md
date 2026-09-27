# Philips HomeID for Homey

Homey SDK v3 application for compatible Philips HomeID appliances. It supports
local Philips Condor communication and FUSION cloud relay devices.

## Supported families

- Air fryers: HD9200, HD9255, HD9280, HD9285, HD9875, HD9876, HD9880
- Multicookers: NX0950, NX0960
- FUSION air purifiers: AC0650, AC0651, AC1715
- Espresso machines: EP2520 (local), EP8757 (FUSION); EP3546/SM family is experimental

Pair the appliance in the official Philips HomeID app first. In Homey, choose
the matching appliance family and sign in by email OTP. Local-only setup is
also available when you already have the Condor client ID and client secret.

For FUSION espresso machines, the Homey device page offers a brew profile,
saved recipe and built-in drink picker, plus buttons for brewing, hot water,
abort, resume and skip step. Bean type and roast level are writable. Matching
Flow actions include machine-named profile, saved-recipe and drink suggestions.
Existing paired espresso devices gain these controls after the app restarts;
they do not need to be paired again. The built-in drink list is narrowed to
the machine's catalog when Philips returns it. Commands are accepted only
while the Philips cloud connection is available.

The older `Brew a drink` Flow card remains for compatibility. Its volume
argument applies to local espresso machines only; FUSION/Rita machines use
their stored recipe volume. Use the dedicated Rita Flow cards for those machines.

## Espresso dashboard widget

On Homey 12.3.0 or newer, add **Espresso Now** to a dashboard and select one
espresso machine. It shows the machine state, the drink name for brews started
through this Homey app, progress when the machine reports it, and available
AquaClean, descaling, coffee-care and brew-group maintenance percentages. The widget
reads the device's cached state every 15 seconds; it does not start extra
Philips cloud requests. The drink name is kept in memory only for the current
brew, so after an app restart or for a brew started at the machine or in the
official app, the widget shows a generic brewing state rather than guessing.

For Rita cloud espresso machines, **Make coffee** opens the profiles and saved
recipes currently reported by the machine. Pick a profile, choose one of its
saved recipes, then press **Brew**. This is an explicit action, not an automatic
brew on selection. The app checks the machine is connected, powered on and idle,
validates the selected recipe again, and blocks duplicate requests for 15 seconds.
The widget reads this menu from the app's cached device state; opening it does
not make another Philips cloud request. Local Condor machines do not show this
control because they do not provide Rita profiles.

For drinks visible in the four supplied HomeID menu screenshots, the widget
displays the corresponding drink image directly from those screenshots. The
original JPEG files are kept intact in `widgets/espresso-now/public/images/philips/`;
the browser only frames the relevant region. Unknown drinks and unknown brew
types continue to use a generic icon rather than a guessed Philips image. The
gallery preview is a stylized illustration of the widget, not a live device view.

## Development

```sh
npm install
npm test
npm run validate
```

This project is independent and is not affiliated with Philips or Versuni.
See `THIRD_PARTY_NOTICES.md` for protocol research attribution.
