import {
  OBJECT_SCOPE, containedItemData, isObjectActor, isObjectItem, objectActorData, objectProperties,
  replacement, tokenDimension
} from "./object-data.mjs";
import {MODULE_ID} from "./controls.mjs";

const queues = new Map();
const syncOptions = () => ({ advancedItemsSync: true });

function actorForDocument(document) {
  if (document.documentName === "Actor") return document;
  return document.actor
    ?? (document.parent?.documentName === "Actor" ? document.parent : document.parent?.actor);
}

function enqueue(uuid, operation) {
  const previous = queues.get(uuid) ?? Promise.resolve();
  const next = previous.then(operation);
  const settled = next.catch(error => {
    console.error(`${MODULE_ID} | Linked item synchronization failed.`, error);
    ui.notifications.error(error.message);
  });
  queues.set(uuid, settled);
  settled.then(() => {
    if (queues.get(uuid) === settled) queues.delete(uuid);
  });
  return settled;
}

export function linkedSource(actor) {
  if (!isObjectActor(actor) || !actor.token?.flags[OBJECT_SCOPE]?.linkItemData) return null;
  const source = fromUuidSync(actor.token.flags[OBJECT_SCOPE].itemUuid, { strict: false });
  if (!isObjectItem(source) || game.items.get(source.id) !== source || !source.isOwner) {
    throw new Error(game.i18n.localize("ADVANCEDITEMS.LinkUnavailable"));
  }
  return source;
}

function cleanItemData(item, stripActor = false) {
  const data = item.toObject();
  if (stripActor && data.flags?.[OBJECT_SCOPE]) delete data.flags[OBJECT_SCOPE].actor;
  return data;
}

async function linkedActorData(item) {
  const data = await objectActorData(item);
  const primary = data.items.find(entry => entry._id === item.id);
  if (primary.flags?.[OBJECT_SCOPE]) delete primary.flags[OBJECT_SCOPE].actor;
  return data;
}

async function refreshLinks(item) {
  const tokens = game.scenes.contents.flatMap(scene => scene.tokens.contents)
    .filter(token => token.flags[OBJECT_SCOPE]?.linkItemData && token.flags[OBJECT_SCOPE].itemUuid === item.uuid);
  if (!tokens.length) return;
  const data = await linkedActorData(item);
  for (const token of tokens) {
    if (!token.isOwner) throw new Error(game.i18n.localize("ADVANCEDITEMS.Permission"));
    // The server has no world Actor from which to adopt new delta collection entries.
    for (const [type, key] of [["Item", "items"], ["ActiveEffect", "effects"]]) {
      const missing = (data[key] ?? []).filter(entry => !token.delta.getEmbeddedCollection(key).manages(entry._id));
      if (missing.length) await token.actor.createEmbeddedDocuments(type, missing, {
        ...syncOptions(), keepId: true
      });
    }
    const update = {
      [`flags.${OBJECT_SCOPE}.actorData`]: replacement(data),
      delta: replacement({ items: data.items, effects: data.effects ?? [] })
    };
    if (!token.flags.dnd5e?.lockSize) {
      const dimension = tokenDimension(objectProperties(item).size);
      if (token._source.width !== dimension) update.width = dimension;
      if (token._source.height !== dimension) update.height = dimension;
    }
    await token.update(update, syncOptions());
    const sheet = token.actor?.items.get(item.id)?.sheet;
    if (sheet?.rendered) await sheet.render({ force: true });
  }
}

async function publishActor(actor, deletedItemId) {
  const source = linkedSource(actor);
  if (!source) return;
  const primary = actor.items.get(source.id);
  if (!primary) throw new Error(game.i18n.localize("ADVANCEDITEMS.LinkUnavailable"));
  const data = cleanItemData(primary, true);
  data.system.container = source.system.container;
  const properties = objectProperties(primary);
  data.flags ??= {};
  data.flags[OBJECT_SCOPE] ??= {};
  data.flags[OBJECT_SCOPE].object = properties;
  const state = actor.toObject();
  const worldContents = await containedItemData(source);
  const worldIds = new Set(worldContents.map(i => i._id));
  if (deletedItemId && worldIds.has(deletedItemId)) {
    await game.items.get(deletedItemId).delete(syncOptions());
  }
  for (const item of actor.items) {
    if (!worldIds.has(item.id)) continue;
    const world = game.items.get(item.id);
    if (!world?.isOwner) throw new Error(game.i18n.localize("ADVANCEDITEMS.Permission"));
    const entry = cleanItemData(item);
    await world.update({
      name: entry.name, img: entry.img, system: replacement(entry.system),
      flags: replacement(entry.flags), effects: replacement(entry.effects)
    }, syncOptions());
  }
  data.flags[OBJECT_SCOPE].actor = {
    ...source.flags[OBJECT_SCOPE]?.actor,
    system: state.system,
    effects: state.effects,
    items: actor.items.filter(i => i.id !== source.id && !worldIds.has(i.id)).map(item => cleanItemData(item))
  };
  await source.update({
    name: data.name, img: data.img, system: replacement(data.system),
    flags: replacement(data.flags), effects: replacement(data.effects)
  }, syncOptions());
  const affected = new Map([[source.id, source]]);
  for (const id of worldIds) {
    const item = game.items.get(id);
    if (item) affected.set(id, item);
  }
  for (const item of affected.values()) {
    const parent = game.items.get(item.system.container);
    if (parent && !affected.has(parent.id)) affected.set(parent.id, parent);
  }
  for (const item of affected.values()) await refreshLinks(item);
}

export function registerItemLinking() {
  for (const type of ["Item", "ActiveEffect"]) {
    for (const operation of ["Create", "Update", "Delete"]) {
      Hooks.on(`pre${operation}${type}`, document => {
        try {
          linkedSource(actorForDocument(document));
        } catch (error) {
          ui.notifications.error(error.message);
          return false;
        }
      });
    }
  }
  const onChange = (document, changes, options, userId) => {
    if (options.advancedItemsSync || userId !== game.user.id) return;
    if (document.documentName === "Actor" && Object.keys(foundry.utils.flattenObject(changes))
      .every(key => ["_id", "flags.dnd5e.lastMovedToken"].includes(key))) return;
    const actor = actorForDocument(document);
    if (isObjectActor(actor) && actor.token?.flags[OBJECT_SCOPE]?.linkItemData) {
      const uuid = actor.token.flags[OBJECT_SCOPE].itemUuid;
      enqueue(uuid, () => publishActor(actor));
      return;
    }
    const item = document.documentName === "Item" ? document : document.parent;
    if (!isObjectItem(item) || game.items.get(item.id) !== item) return;
    const roots = [item];
    let container = item.system.container;
    while (container) {
      const parent = game.items.get(container);
      if (!parent || roots.includes(parent)) break;
      roots.push(parent);
      container = parent.system.container;
    }
    for (const root of roots) enqueue(root.uuid, () => refreshLinks(root));
  };
  for (const type of ["Actor", "Item", "ActiveEffect"]) {
    Hooks.on(`update${type}`, onChange);
    if (type !== "Actor") {
      Hooks.on(`create${type}`, (doc, options, userId) => onChange(doc, {}, options, userId));
      Hooks.on(`delete${type}`, (doc, options, userId) => {
        if (options.advancedItemsSync || userId !== game.user.id) return;
        if (doc.documentName === "Item" && isObjectActor(doc.actor) && doc.actor.token?.flags[OBJECT_SCOPE]?.linkItemData) {
          enqueue(doc.actor.token.flags[OBJECT_SCOPE].itemUuid, () => publishActor(doc.actor, doc.id));
        } else if (doc.documentName === "Item" && game.items.get(doc.id) !== doc && !doc.parent) {
          for (const scene of game.scenes) for (const token of scene.tokens) {
            if (token.flags[OBJECT_SCOPE]?.itemUuid === doc.uuid && token.flags[OBJECT_SCOPE].linkItemData) {
              enqueue(doc.uuid, () => token.update({ [`flags.${OBJECT_SCOPE}.linkItemData`]: false }, syncOptions()));
            }
          }
          let parent = game.items.get(doc.system.container);
          const visited = new Set();
          while (parent && !visited.has(parent.id)) {
            visited.add(parent.id);
            const container = parent;
            enqueue(container.uuid, () => refreshLinks(container));
            parent = game.items.get(parent.system.container);
          }
        } else onChange(doc, {}, options, userId);
      });
    }
  }
  Hooks.on("updateToken", (token, changes, options, userId) => {
    if (options.advancedItemsSync || userId !== game.user.id) return;
    if (foundry.utils.expandObject(changes).flags?.[OBJECT_SCOPE]?.linkItemData === true) {
      const source = linkedSource(token.actor);
      enqueue(source.uuid, () => refreshLinks(source));
    }
  });
  Hooks.on("preDeleteItem", item => {
    if (item.actor?.token?.flags[OBJECT_SCOPE]?.linkItemData && item.id === item.actor.flags[OBJECT_SCOPE]?.itemId) {
      ui.notifications.error(game.i18n.localize("ADVANCEDITEMS.LinkedPrimary"));
      return false;
    }
  });
}
