'use strict';

// Rita's Profiles and Recipes ports contain base64-encoded protobuf messages.
const DRINKS = Object.freeze({
  1: 'Ristretto', 2: 'Espresso', 4: 'Espresso Lungo', 5: 'Double Espresso',
  7: 'Caffè Crema', 8: 'Americano', 10: 'Espresso Macchiato', 11: 'Cortado',
  13: 'Mélange', 14: 'Cappuccino', 15: 'Flat White', 16: 'Caffè Latte',
  17: 'Café au Lait', 19: 'Latte Macchiato', 20: 'Froth Milk', 23: 'Galão',
  24: 'Italian Cappuccino', 35: 'Long Black', 38: 'Cut', 39: 'Red Eye',
  40: 'Black Eye', 41: 'Dripped Eye', 42: 'Piccolo Latte', 43: 'Magic',
  54: 'Babyccino', 61: 'Cappuccino XL',
});

function readVarint(bytes, start) {
  let value = 0;
  let offset = start;
  let shift = 0;
  while (offset < bytes.length && shift <= 49) {
    const byte = bytes[offset++];
    value += (byte & 0x7f) * (2 ** shift);
    if (!(byte & 0x80)) return [value, offset];
    shift += 7;
  }
  throw new Error('Invalid protobuf varint');
}

function fields(blob) {
  if (typeof blob !== 'string' || !blob || !/^[A-Za-z0-9+/]*={0,2}$/.test(blob)) return [];
  const bytes = Buffer.from(blob, 'base64');
  const result = [];
  try {
    for (let offset = 0; offset < bytes.length;) {
      const [tag, next] = readVarint(bytes, offset);
      offset = next;
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (!field) throw new Error('Invalid protobuf field');
      if (wire === 0) {
        const [value, end] = readVarint(bytes, offset);
        result.push({ field, wire, value });
        offset = end;
      } else if (wire === 2) {
        const [length, end] = readVarint(bytes, offset);
        if (end + length > bytes.length) throw new Error('Truncated protobuf field');
        result.push({ field, wire, value: bytes.subarray(end, end + length) });
        offset = end + length;
      } else if (wire === 1 || wire === 5) {
        offset += wire === 1 ? 8 : 4;
        if (offset > bytes.length) throw new Error('Truncated protobuf field');
      } else throw new Error('Unsupported protobuf wire type');
    }
    return result;
  } catch (error) {
    return [];
  }
}

function varintField(blob, field) {
  return fields(blob).find((item) => item.field === field && item.wire === 0)?.value ?? null;
}

function profileRecipeIds(blob) {
  const result = [];
  try {
    for (const item of fields(blob)) {
      if (item.field !== 4) continue;
      if (item.wire === 0 && item.value && !result.includes(item.value)) result.push(item.value);
      if (item.wire === 2) {
        for (let offset = 0; offset < item.value.length;) {
          const [id, next] = readVarint(item.value, offset);
          if (id && !result.includes(id)) result.push(id);
          offset = next;
        }
      }
    }
  } catch (error) {
    return [];
  }
  return result;
}

function names(value, count) {
  if (typeof value !== 'string') return Array(count).fill('');
  return Array.from({ length: count }, (_, index) => (value.split(',')[index] || '').trim());
}

function profiles(properties) {
  const port = properties.Profiles || {};
  const labels = names(port.Pr_Names, 8);
  const counts = new Map();
  for (const label of labels.filter(Boolean)) counts.set(label, (counts.get(label) || 0) + 1);
  return Array.from({ length: 8 }, (_, slot) => ({
    slot,
    id: varintField(port[`profile${slot}`], 1),
    name: counts.get(labels[slot]) > 1 ? `${slot}: ${labels[slot]}` : (labels[slot] || `Profile ${slot}`),
  })).filter((profile) => profile.id > 0);
}

function savedRecipes(properties, profileSlot, drinkNames = DRINKS) {
  const profile = properties.Profiles?.[`profile${profileSlot}`];
  const orderedIds = profileRecipeIds(profile);
  if (!orderedIds.length) return [];
  const p1 = properties.Recipes_p1 || {};
  const p2 = properties.Recipes_p2 || {};
  const allNames = [...names(p1.Rec_Names, 40), ...names(p2.Rec_Names, 40)];
  const result = [];
  for (const id of orderedIds) {
    for (let slot = profileSlot * 8; slot < (profileSlot + 1) * 8 && slot < 80; slot++) {
      const blob = (slot < 40 ? p1 : p2)[`rcp${slot}`];
      if (!blob || varintField(blob, 1) !== id) continue;
      const drinkName = drinkNames[varintField(blob, 2)];
      result.push({ slot, id, name: allNames[slot] || drinkName || `Recipe ${slot}`, blob });
    }
  }
  const counts = new Map();
  for (const recipe of result) counts.set(recipe.name, (counts.get(recipe.name) || 0) + 1);
  return result.map((recipe) => ({
    ...recipe,
    name: counts.get(recipe.name) > 1 ? `${recipe.slot}: ${recipe.name}` : recipe.name,
  }));
}

module.exports = { DRINKS, varintField, profileRecipeIds, profiles, savedRecipes };
