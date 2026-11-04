import {MODULE_ID} from "./controls.mjs";
import {createObjectToken} from "./objects.mjs";
import {
  OBJECT_SCOPE, isObjectActor, isObjectItem as isPhysicalItem, objectProperties, replacement, setCargoState
} from "./object-data.mjs";

const busy = new Set();
export {isPhysicalItem};

export const localize = key => game.i18n.localize(`ADVANCED_DRAG_DROP.${key}`);

export function report(error) {
  if (error?.name === "AbortError") return;
  console.error(`${MODULE_ID} |`, error);
  ui.notifications.error(error.message || localize("Failed"));
}

export function assert(condition, key = "Invalid") {
  if (!condition) throw new Error(localize(key));
}

export function sourceForToken(token) {
  const actor = token.actor;
  if (isObjectActor(actor)) {
    const item = actor.items.get(actor.flags[OBJECT_SCOPE].itemId);
    return {kind: "item", item, token, uuid: token.uuid};
  }
  return {kind: "actor", actor, token, uuid: token.uuid};
}

class TransferJournal {
  undo = [];

  async rollback() {
    const errors = [];
    for (const restore of this.undo.reverse()) {
      try { await restore(); }
      catch (error) { errors.push(error); }
    }
    return errors;
  }
}

async function promptQuantity(item) {
  const total = Number(item.system.quantity ?? 1);
  if (total <= 1 || item.type === "container") return total;
  const Base = dnd5e.applications.api.Dialog5e;
  return new Promise((resolve, reject) => {
    class QuantityDialog extends Base {
      static DEFAULT_OPTIONS = {
        buttons: [{id: "move", label: "ADVANCED_DRAG_DROP.Move", icon: "fa-solid fa-arrow-right-arrow-left"}],
        classes: ["split-stack"],
        position: {width: 400},
        form: {
          handler(_event, _form, data) {
            const quantity = Number(data.object.right);
            if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > total) return;
            resolve(quantity);
            return this.close();
          }
        }
      };

      static PARTS = {
        ...Base.PARTS,
        content: {template: "systems/dnd5e/templates/apps/split-stack-dialog.hbs"}
      };

      async _prepareContentContext(context) {
        return {...context, max: total, left: 0, right: total};
      }

      _onClose(options) {
        resolve(null);
        return super._onClose(options);
      }
    }
    const dialog = new QuantityDialog({window: {title: `${localize("Move")}: ${item.name}`}});
    dialog.render({force: true}).catch(reject);
  });
}

async function itemBundle(source, quantity) {
  const item = source.item;
  const contents = item.type === "container" ? await item.system.allContainedItems : [];
  assert(contents.every(child => child.isOwner), "Permission");
  const data = await Item.implementation.createWithContents([item]);
  assert(data.length > 0);
  const root = data[0];
  root.system.quantity = quantity;
  if (source.token) {
    const actor = source.token.actor;
    root.flags ??= {};
    root.flags[OBJECT_SCOPE] ??= {};
    root.flags[OBJECT_SCOPE].object = objectProperties(item);
    const excluded = new Set([item.id, ...contents.map(child => child.id)]);
    const prototypeToken = source.token.toObject();
    for (const key of ["_id", "actorId", "delta", "x", "y", "elevation", "sort"]) delete prototypeToken[key];
    delete prototypeToken.flags?.[OBJECT_SCOPE];
    root.flags[OBJECT_SCOPE].actor = {
      system: actor.system.toObject(),
      effects: actor.effects.map(effect => effect.toObject()),
      items: actor.items.filter(child => !excluded.has(child.id)).map(child => child.toObject()),
      prototypeToken
    };
  }
  return data;
}

function fingerprints(source) {
  if (source.kind === "crew") return JSON.stringify(source.vehicle.system[source.area].value);
  return JSON.stringify((source.token ?? source.item).toObject());
}

async function prepare(source, target, quantityPrompt) {
  if (source.kind === "actor") {
    assert(target.kind === "crew", "Invalid");
    assert(source.token.isOwner && source.actor?.isOwner && target.actor.isOwner, "Permission");
    const actor = game.actors.get(source.token.actorId);
    assert(actor && actor.system.isCreature && source.actor.system.isCreature);
    assert(actor.isOwner, "Permission");
    assert(source.token.parent === canvas.scene);
    const snapshot = source.token.toObject();
    if (!source.token.actorLink) delete snapshot.delta;
    return {...source, actor, snapshot, before: JSON.stringify(source.token.toObject())};
  }
  if (source.kind === "crew") {
    assert(target.kind === "canvas");
    assert(source.vehicle.isOwner && source.actor?.isOwner && game.user.can("TOKEN_CREATE"), "Permission");
    const roster = source.vehicle.system[source.area].value;
    assert(roster.includes(source.actor.uuid));
    const snapshots = source.vehicle.flags[MODULE_ID]?.occupants ?? [];
    const saved = snapshots.find(entry => entry.area === source.area && entry.actorUuid === source.actor.uuid);
    return {...source, saved, before: fingerprints(source)};
  }
  const item = source.item;
  assert(isPhysicalItem(item));
  assert(item.isOwner && (!source.token || source.token.isOwner), "Permission");
  const before = fingerprints(source);
  assert(target.kind === "inventory" || target.kind === "canvas");
  if (target.kind === "inventory") {
    assert((target.actor ?? target.container)?.isOwner, "Permission");
    assert(!target.app?.constructor.unsupportedItemTypes?.has(item.type));
    if (target.container) {
      assert(target.container !== item);
      const parents = await target.container.system.allContainers();
      assert(!parents.some(parent => parent.uuid === item.uuid), "Recursive");
      assert(await target.container.system.canDropContents(), "Permission");
    }
  } else {
    assert(game.user.can("TOKEN_CREATE"), "Permission");
  }
  const sameActor = target.kind === "inventory" && !source.token && item.actor
    && target.actor?.uuid === item.actor.uuid;
  const quantity = sameActor ? Number(item.system.quantity ?? 1) : await quantityPrompt(item);
  if (quantity === null) throw new DOMException("Canceled", "AbortError");
  assert(fingerprints(source) === before, "Changed");
  assert(Number.isSafeInteger(quantity) && quantity > 0 && quantity <= Number(item.system.quantity ?? 1));
  const data = sameActor ? [] : await itemBundle(source, quantity);
  const original = [item.toObject(), ...(item.type === "container"
    ? (await item.system.allContainedItems).map(child => child.toObject()) : [])];
  return {...source, quantity, data, original, sameActor, before};
}

async function createItems(data, parent, journal) {
  const collection = parent?.items ?? game.items;
  const ids = data.map(entry => entry._id);
  assert(ids.every(id => !collection.has(id)));
  if (!parent) assert(game.user.can("ITEM_CREATE"), "Permission");
  journal.undo.push(async () => {
    const existing = ids.filter(id => collection.has(id));
    if (existing.length) await Item.implementation.deleteDocuments(existing, {parent, deleteContents: false});
    assert(ids.every(id => !collection.has(id)), "Recovery");
  });
  const created = await Item.implementation.createDocuments(data, {parent, keepId: true});
  assert(created.length === ids.length && ids.every(id => collection.has(id)), "Failed");
  return created;
}

async function createToken(data, scene, journal) {
  data._id = foundry.utils.randomID();
  journal.undo.push(async () => {
    if (scene.tokens.has(data._id)) await scene.deleteEmbeddedDocuments("Token", [data._id]);
    assert(!scene.tokens.has(data._id), "Recovery");
  });
  const created = await scene.createEmbeddedDocuments("Token", [data], {keepId: true});
  assert(created.length === 1 && scene.tokens.has(data._id), "Failed");
  return created[0];
}

async function updateRoster(vehicle, area, updates, journal) {
  const rosterKey = `system.${area}.value`;
  const metadataKey = `flags.${MODULE_ID}.occupants`;
  const before = {
    [rosterKey]: foundry.utils.deepClone(vehicle.system[area].value),
    [metadataKey]: foundry.utils.deepClone(vehicle.flags[MODULE_ID]?.occupants ?? [])
  };
  const expected = {...before, ...updates};
  const state = () => ({[rosterKey]: [...vehicle.system[area].value],
    [metadataKey]: foundry.utils.deepClone(vehicle.flags[MODULE_ID]?.occupants ?? [])});
  journal.undo.push(async () => {
    const current = JSON.stringify(state());
    if (current === JSON.stringify(before)) return;
    assert(current === JSON.stringify(expected), "Recovery");
    await vehicle.update({...before,
      [metadataKey]: replacement(before[metadataKey])});
    assert(JSON.stringify(state()) === JSON.stringify(before), "Recovery");
  });
  await vehicle.update({...updates,
    [metadataKey]: replacement(expected[metadataKey])});
  assert(JSON.stringify(state()) === JSON.stringify(expected), "Changed");
}

async function destination(source, target, journal, offset) {
  if (source.kind === "actor") {
    const vehicle = target.actor;
    const occupants = foundry.utils.deepClone(vehicle.flags[MODULE_ID]?.occupants ?? []);
    const updates = vehicle.system.getCrewUpdates(target.area, source.actor.uuid, "+1");
    updates[`flags.${MODULE_ID}.occupants`] = [...occupants, {
      id: foundry.utils.randomID(), area: target.area, actorUuid: source.actor.uuid, tokenData: source.snapshot
    }];
    await updateRoster(vehicle, target.area, updates, journal);
    return;
  }
  if (source.kind === "crew") {
    const token = await source.actor.getTokenDocument(source.saved?.tokenData ?? {});
    const data = token.toObject();
    const position = CONFIG.Token.objectClass._getDropActorPosition(token, {
      x: target.x + offset, y: target.y + offset, elevation: target.elevation
    }, {snap: !target.shiftKey});
    Object.assign(data, position, {actorId: source.actor.id, actorLink: source.saved?.tokenData.actorLink ?? true});
    if (!data.actorLink) data.delta = {};
    await createToken(data, target.scene, journal);
    return;
  }
  if (source.sameActor) {
    const container = source.item.system.container;
    journal.undo.push(() => source.item.update({"system.container": container}));
    await source.item.update({"system.container": target.container?.id ?? null});
    assert(source.item.system.container === (target.container?.id ?? null), "Failed");
    return;
  }
  const data = foundry.utils.deepClone(source.data);
  const root = data[0];
  root.system.container = target.kind === "inventory" ? target.container?.id ?? null : null;
  for (const entry of data) {
    setCargoState(entry, target.actor?.type === "vehicle");
    delete entry.system.attuned;
    delete entry.system.prepared;
    if (entry.system.crew) delete entry.system.crew.value;
  }
  if (target.kind === "inventory") {
    await createItems(data, target.actor, journal);
    return;
  }
  const created = await createItems(data, undefined, journal);
  const placement = {...target, x: target.x + offset, y: target.y + offset};
  const token = await createObjectToken(created[0], placement, target);
  assert(token, "Failed");
  journal.undo.push(async () => {
    if (token.parent.tokens.has(token.id)) await token.delete();
    assert(!token.parent.tokens.has(token.id), "Recovery");
  });
}

async function removeSource(source, journal) {
  if (source.sameActor) return;
  if (source.kind === "crew") {
    const vehicle = source.vehicle;
    assert(fingerprints(source) === source.before, "Changed");
    const occupants = foundry.utils.deepClone(vehicle.flags[MODULE_ID]?.occupants ?? []);
    const updates = vehicle.system.getCrewUpdates(source.area, source.actor.uuid, "-1");
    if (source.saved) updates[`flags.${MODULE_ID}.occupants`] = occupants.filter(entry => entry.id !== source.saved.id);
    await updateRoster(vehicle, source.area, updates, journal);
    return;
  }
  assert(fingerprints(source) === source.before, "Changed");
  const whole = source.kind === "actor" || source.quantity === Number(source.item.system.quantity ?? 1);
  if (source.token && whole) {
    const token = source.token;
    const data = token.toObject();
    journal.undo.push(async () => {
      if (!token.parent.tokens.has(token.id)) await token.parent.createEmbeddedDocuments("Token", [data], {keepId: true});
      assert(token.parent.tokens.has(token.id), "Recovery");
    });
    await token.delete();
    assert(!token.parent.tokens.has(token.id), "Failed");
    return;
  }
  const item = source.item;
  if (!source.token && !item.actor) {
    if (!item.system.container) return;
    if (whole) {
      const container = item.system.container;
      journal.undo.push(() => item.update({"system.container": container}));
      await item.update({"system.container": null});
      assert(item.system.container === null, "Failed");
      return;
    }
  }
  if (!whole) {
    const quantity = item.system.quantity;
    const linked = source.token?.flags?.[OBJECT_SCOPE]?.linkItemData;
    journal.undo.push(async () => {
      await item.update({"system.quantity": quantity}, {advancedItemsSync: true});
      if (linked) await source.token.update({[`flags.${OBJECT_SCOPE}.linkItemData`]: true});
    });
    if (linked) await source.token.update({[`flags.${OBJECT_SCOPE}.linkItemData`]: false});
    await item.update({"system.quantity": quantity - source.quantity}, {advancedItemsSync: !!source.token});
    assert(item.system.quantity === quantity - source.quantity, "Failed");
    return;
  }
  const parent = item.parent;
  const collection = parent?.items ?? game.items;
  journal.undo.push(async () => {
    const missing = source.original.filter(entry => !collection.has(entry._id));
    if (missing.length) await Item.implementation.createDocuments(missing, {parent, keepId: true});
    assert(source.original.every(entry => collection.has(entry._id)), "Recovery");
  });
  await Item.implementation.deleteDocuments(source.original.map(entry => entry._id), {parent, deleteContents: false});
  assert(source.original.every(entry => !collection.has(entry._id)), "Failed");
}

export async function transfer(sources, target, {quantityPrompt = promptQuantity} = {}) {
  assert(sources.length && new Set(sources.map(source => source.uuid)).size === sources.length);
  const keys = [...sources.map(source => source.uuid), target.actor?.uuid, target.container?.uuid,
    target.scene?.uuid].filter(Boolean);
  assert(keys.every(key => !busy.has(key)), "Busy");
  keys.forEach(key => busy.add(key));
  const journal = new TransferJournal();
  try {
    const prepared = [];
    for (const source of sources) prepared.push(await prepare(source, target, quantityPrompt));
    for (const source of prepared) assert(fingerprints(source) === source.before, "Changed");
    if (target.kind === "canvas") assert(target.scene === canvas.scene
      && canvas.dimensions.rect.contains(target.x, target.y), "Invalid");
    for (const [index, source] of prepared.entries()) {
      await destination(source, target, journal, target.kind === "canvas" ? index * canvas.grid.size : 0);
    }
    for (const source of prepared) await removeSource(source, journal);
    return true;
  } catch (error) {
    const recoveryErrors = await journal.rollback();
    if (recoveryErrors.length) {
      console.error(`${MODULE_ID} | Recovery required`, {sources: sources.map(source => source.uuid),
        target: target.actor?.uuid ?? target.scene?.uuid, error, recoveryErrors});
      throw new Error(localize("Recovery"), {cause: error});
    }
    throw error;
  } finally {
    keys.forEach(key => busy.delete(key));
  }
}