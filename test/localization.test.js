'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const translatedLanguages = fs.readdirSync(path.join(root, 'locales'))
  .filter((name) => name.endsWith('.json') && name !== 'en.json')
  .map((name) => path.basename(name, '.json'));

function visitTranslations(value, language, location) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.en === 'string' || Array.isArray(value.en)) {
    assert.ok(Object.hasOwn(value, language), `${location}: missing ${language}`);
    if (Array.isArray(value.en)) {
      assert.equal(value[language].length, value.en.length, `${location}: ${language} option count`);
    } else {
      assert.equal(typeof value[language], 'string', `${location}: ${language} must be text`);
      const placeholders = (text) => [...text.matchAll(/\[\[[^\]]+\]\]|__[^_]+__/g)].map(([match]) => match).sort();
      assert.deepEqual(placeholders(value[language]), placeholders(value.en), `${location}: ${language} placeholders`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) visitTranslations(child, language, `${location}.${key}`);
}

function compareLocale(english, translated, location) {
  if (typeof english === 'string') {
    assert.equal(typeof translated, 'string', location);
    assert.ok(translated.length > 0, location);
    return;
  }
  assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), `${location}: keys`);
  for (const [key, value] of Object.entries(english)) compareLocale(value, translated[key], `${location}.${key}`);
}

test('each advertised translation has complete Homey metadata, pairing text, README and widget copy', () => {
  const sourceFiles = [path.join(root, '.homeycompose', 'app.json'), path.join(root, 'widgets', 'espresso-now', 'widget.compose.json')];
  for (const driver of fs.readdirSync(path.join(root, 'drivers'))) {
    const file = path.join(root, 'drivers', driver, 'driver.compose.json');
    if (fs.existsSync(file)) sourceFiles.push(file);
  }
  for (const folder of ['capabilities', 'flow/actions', 'flow/conditions', 'flow/triggers']) {
    const directory = path.join(root, '.homeycompose', folder);
    sourceFiles.push(...fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => path.join(directory, name)));
  }
  const englishLocale = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json'), 'utf8'));
  const widgetHtml = fs.readFileSync(path.join(root, 'widgets/espresso-now/public/index.html'), 'utf8');
  const widgetObject = widgetHtml.match(/const strings = (\{[\s\S]*?\n\s*\});\n\s*const language/)?.[1];
  assert.ok(widgetObject, 'Widget translations should be present');
  const widgetStrings = vm.runInNewContext(`(${widgetObject})`);

  for (const language of translatedLanguages) {
    for (const file of sourceFiles) visitTranslations(JSON.parse(fs.readFileSync(file, 'utf8')), language, path.relative(root, file));
    const locale = JSON.parse(fs.readFileSync(path.join(root, `locales/${language}.json`), 'utf8'));
    compareLocale(englishLocale, locale, `locales/${language}.json`);
    assert.ok(fs.readFileSync(path.join(root, `README.${language}.txt`), 'utf8').trim().length > 50);
    assert.deepEqual(Object.keys(widgetStrings[language]).sort(), Object.keys(widgetStrings.en).sort(), `${language} widget keys`);
    assert.equal(locale.widget.espressoNow.language, language, `${language} Homey widget language`);
    for (const [key, value] of Object.entries(widgetStrings[language])) {
      assert.equal(locale.widget.espressoNow[key], value, `${language} widget.${key}`);
    }
  }
});
