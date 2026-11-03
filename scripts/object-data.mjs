export const OBJECT_SCOPE = "advanced-items";
export const ITEM_TYPES = new Set(["consumable", "container", "equipment", "loot", "tool", "weapon"]);
export const OBJECT_TRAITS = ["dr", "di", "ci", "dv", "dm"];

export function isObjectItem(item) {
  return item?.documentName === "Item" && ITEM_TYPES.has(item.type);
}

export function isObjectActor(actor) {
  return actor?.flags?.[OBJECT_SCOPE]?.object === true;
}

export function isMountable(item) {
  return (item.type === "weapon" && item.system.type?.value === "siege")
    || (item.type === "equipment" && item.system.type?.value === "vehicle");
}

export function objectProperties(item) {
  const stored = item.flags?.[OBJECT_SCOPE]?.object ?? {};
  const actor = isObjectActor(item.actor) ? item.actor : null;
  const hp = actor?.system.attributes.hp ?? item.system.hp ?? stored.hp ?? {};
  const traits = actor?.system.toObject().traits
    ?? { ...item.flags?.[OBJECT_SCOPE]?.actor?.system?.traits, ...stored.traits };
  return {
    size: actor?.system.traits.size ?? stored.size ?? traits.size ?? "sm",
    traits: Object.fromEntries(OBJECT_TRAITS.map(key => [key, foundry.utils.deepClone(traits[key]
      ?? (key === "dm" ? { amount: {}, bypasses: [] }
        : { value: key === "di" ? ["poison", "psychic"] : [], custom: "", ...(key === "ci" ? {} : { bypasses: [] }) }))])),
    ac: actor?.system.attributes.ac.value ?? stored.ac ?? (isMountable(item) ? item.system.armor?.value : null) ?? 10,
    hp: {
      value: hp.value ?? 0,
      max: hp.max ?? 0,
      dt: hp.dt ?? 0,
      conditions: actor?.flags?.[OBJECT_SCOPE]?.hpConditions ?? hp.conditions ?? stored.hp?.conditions ?? ""
    }
  };
}

export function itemOwnership(item) {
  return foundry.utils.deepClone(item.actor?.ownership ?? item.ownership);
}

export const tokenDimension = size => CONFIG.DND5E.actorSizes[size]?.token ?? 1;

export function actorDataForItem(item) {
  const { ac, hp, size, traits } = objectProperties(item);
  const itemData = item.toObject();
  itemData.system.container = null;
  const actorData = foundry.utils.deepClone(item.flags?.[OBJECT_SCOPE]?.actor ?? {});
  actorData.system ??= {};
  actorData.prototypeToken ??= {};
  foundry.utils.mergeObject(actorData, {
    _id: item.id,
    name: item.name,
    type: "npc",
    img: item.img,
    ownership: itemOwnership(item),
    system: {
      attributes: {
        ac: { override: ac },
        hp: { value: hp.value, max: hp.max, dt: hp.dt }
      },
      traits: { ...traits, size },
      details: { type: { value: "custom", custom: "Object" } }
    },
    flags: { [OBJECT_SCOPE]: { object: true, itemUuid: item.uuid, itemId: item.id, hpConditions: hp.conditions } },
    items: [itemData, ...foundry.utils.deepClone(item.flags?.[OBJECT_SCOPE]?.actor?.items ?? [])]
  });
  foundry.utils.mergeObject(actorData.prototypeToken, {
    actorLink: false,
    name: actorData.prototypeToken.name ?? item.name,
    texture: { src: actorData.prototypeToken.texture?.src ?? item.img },
    bar1: actorData.prototypeToken.bar1 ?? { attribute: "attributes.hp" },
    width: actorData.prototypeToken.width ?? tokenDimension(size),
    height: actorData.prototypeToken.height ?? tokenDimension(size)
  });
  return actorData;
}

export async function objectActorData(item) {
  const actorData = actorDataForItem(item);
  const ids = new Set(actorData.items.map(entry => entry._id));
  actorData.items.push(...(await containedItemData(item)).filter(entry => !ids.has(entry._id)));
  return actorData;
}

export function objectPropertyUpdate(item, path, value) {
  const update = { [`flags.${OBJECT_SCOPE}.object.${path}`]: value };
  if (path.startsWith("hp.") && ("hp" in item.system.schema.fields)) {
    update[`system.${path}`] = value;
  }
  if (path === "ac" && isMountable(item)) update["system.armor.value"] = value;
  return update;
}

export async function containedItemData(item) {
  if (item.type !== "container") return [];
  const contents = await item.system.allContainedItems;
  if (contents.some(child => !child.isOwner)) throw new Error(game.i18n.localize("ADVANCEDITEMS.Permission"));
  return contents.map(child => child.toObject());
}

export function synchronizeObjectItem(actor, data) {
  if (!actor.isToken || !isObjectActor(actor)) return data;
  const item = actor.items.get(actor.flags[OBJECT_SCOPE].itemId);
  if (!item) return data;
  const expanded = foundry.utils.expandObject(data);
  const updates = {};
  const traits = expanded.system?.traits;
  if (traits) {
    const candidate = new CONFIG.Actor.documentClass(actor.toObject());
    candidate.updateSource({ system: { traits } });
    for (const key of OBJECT_TRAITS) {
      if (key in traits) updates[`flags.${OBJECT_SCOPE}.object.traits.${key}`] =
        new foundry.data.operators.ForcedReplacement(candidate.system.toObject().traits[key]);
    }
    if ("size" in traits) Object.assign(updates, objectPropertyUpdate(item, "size", candidate.system.traits.size));
  }
  const hp = expanded.system?.attributes?.hp;
  for (const key of ["value", "max", "dt"]) {
    if (hp && key in hp) Object.assign(updates, objectPropertyUpdate(item, `hp.${key}`, hp[key]));
  }
  const ac = expanded.system?.attributes?.ac;
  if (ac && "override" in ac) Object.assign(updates, objectPropertyUpdate(item, "ac", ac.override));
  const flags = expanded.flags?.[OBJECT_SCOPE];
  if (flags && "hpConditions" in flags) {
    Object.assign(updates, objectPropertyUpdate(item, "hp.conditions", flags.hpConditions));
  }
  if (!Object.keys(updates).length) return data;
  expanded.items ??= [];
  let ownItem = expanded.items.find(update => update._id === item.id);
  if (!ownItem) expanded.items.push(ownItem = { _id: item.id });
  foundry.utils.mergeObject(ownItem, foundry.utils.expandObject(updates));
  return expanded;
}
