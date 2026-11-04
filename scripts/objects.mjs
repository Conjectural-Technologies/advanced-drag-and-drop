import {
  OBJECT_SCOPE, OBJECT_TRAITS, actorDataForItem, isMountable, isObjectItem, isObjectItemType, isObjectActor,
  containedItemData, objectActorData, objectBypassTraits, objectProperties, objectPropertyUpdate,
  remapItemIds, replacement, setCargoState, synchronizeObjectItem, tokenDimension
} from "./object-data.mjs";
import { linkedSource, registerItemLinking } from "./item-linking.mjs";
import { MODULE_ID } from "./controls.mjs";

const baseActors = new WeakMap();
const observers = new WeakMap();
const localize = key => game.i18n.localize(key);

function reportError(error) {
  console.error(`${MODULE_ID} | Objects`, error);
  ui.notifications.error(error.message || localize("ADVANCEDITEMS.Failure"));
}

function run(operation) {
  Promise.resolve().then(operation).catch(reportError);
}

function registerDocuments() {
  const BaseItem = CONFIG.Item.documentClass;
  CONFIG.Item.documentClass = class ObjectItem extends BaseItem {
    get isMountable() {
      if (this.actor?.type === "vehicle" && this.flags?.[OBJECT_SCOPE]?.cargo) return false;
      return super.isMountable;
    }
  };
  Hooks.on("preCreateItem", item => {
    if (item.actor?.type !== "vehicle" || !isObjectItem(item)) return;
    item.updateSource({ [`flags.${OBJECT_SCOPE}.cargo`]: true });
  });

  const BaseActor = CONFIG.Actor.documentClass;
  CONFIG.Actor.documentClass = class ObjectActor extends BaseActor {
    get isObject() {
      return isObjectActor(this);
    }

    get sheet() {
      if (this.isToken && this.isObject) {
        const item = this.items.get(this.flags[OBJECT_SCOPE].itemId);
        if (item) return item.sheet;
      }
      return super.sheet;
    }

    async rollAbilityCheck(...args) {
      if (!this.isObject) return super.rollAbilityCheck(...args);
      return null;
    }

    async rollSkill(...args) {
      if (!this.isObject) return super.rollSkill(...args);
      return this.rollAbilityCheck(...args);
    }

    async rollToolCheck(...args) {
      if (!this.isObject) return super.rollToolCheck(...args);
      return this.rollAbilityCheck(...args);
    }

    async rollSavingThrow(config = {}, dialog = {}, message = {}) {
      if (!this.isObject) return super.rollSavingThrow(config, dialog, message);
      const target = Number.isFinite(config.target) ? config.target : 1;
      // A constant native roll records failure for chat-card targeting without rolling ability dice.
      const RollClass = dnd5e.dice.BasicRoll;
      const roll = await new RollClass(String(target - 1), {}, {
        target, [OBJECT_SCOPE]: { automaticFailure: true }
      }).evaluate();
      const ability = CONFIG.DND5E.abilities[config.ability]?.label ?? "";
      const data = foundry.utils.mergeObject({
        type: "save",
        speaker: ChatMessage.getSpeaker({ actor: this }),
        flavor: `${game.i18n.format("DND5E.SavePromptTitle", { ability: localize(ability) })}: ${
          localize("ADVANCEDITEMS.AutomaticFailure")}`,
        system: { ability: config.ability }
      }, message.data ?? {});
      if (message.create !== false) {
        await RollClass.toMessage([roll], data, { rollMode: message.rollMode });
      }
      Hooks.callAll("dnd5e.rollSavingThrow", [roll], { ability: config.ability, subject: this });
      return [roll];
    }

    async update(data, options = {}) {
      if (!options.advancedItemsSync) linkedSource(this);
      if (!this.isToken && this.isObject) {
        const item = await fromUuid(this.flags[OBJECT_SCOPE].itemUuid);
        if (!isObjectItem(item) || !item.isOwner) throw new Error(localize("ADVANCEDITEMS.Permission"));
        const expanded = foundry.utils.expandObject(data);
        if (expanded.type === this.type) delete expanded.type;
        if (Object.keys(expanded).some(key => !["_id", "prototypeToken", "system"].includes(key))
          || (expanded.system && Object.keys(expanded.system).some(key => key !== "traits"))
          || (expanded.system?.traits && Object.keys(expanded.system.traits).some(key => !OBJECT_TRAITS.includes(key) && key !== "size"))) {
          throw new Error("Item-backed base actors can only update object traits and their prototype token.");
        }
        const candidate = new CONFIG.Actor.documentClass(this.toObject());
        candidate.updateSource(expanded);
        const updates = {};
        if (expanded.prototypeToken) {
          const prototype = candidate.prototypeToken.toObject();
          prototype.actorLink = false;
          updates[`flags.${OBJECT_SCOPE}.actor.prototypeToken`] = replacement(prototype);
        }
        for (const key of OBJECT_TRAITS) {
          if (expanded.system?.traits && key in expanded.system.traits) {
            updates[`flags.${OBJECT_SCOPE}.object.traits.${key}`] =
              replacement(candidate.system.toObject().traits[key]);
          }
        }
        if (expanded.system?.traits?.size) updates[`flags.${OBJECT_SCOPE}.object.size`] = candidate.system.traits.size;
        await item.update(updates, options);
        this.updateSource(expanded);
        return this;
      }
      const actor = await super.update(synchronizeObjectItem(this, data), options);
      const size = foundry.utils.expandObject(data).system?.traits?.size;
      if (this.isObject && this.token && size && !this.token.flags.dnd5e?.lockSize) {
        const dimension = tokenDimension(size);
        await this.token.update({ width: dimension, height: dimension });
      }
      return actor;
    }
  };

  const BaseNPC = CONFIG.Actor.dataModels.npc;
  CONFIG.Actor.dataModels.npc = class ObjectNPCData extends BaseNPC {
    get isCreature() {
      return !isObjectActor(this.parent) && super.isCreature;
    }

    get isObject() {
      return isObjectActor(this.parent);
    }
  };

  const BaseToken = CONFIG.Token.documentClass;
  CONFIG.Token.documentClass = class ObjectTokenDocument extends BaseToken {
    _onUpdate(changes, options, userId) {
      if (changes.flags?.[OBJECT_SCOPE]?.actorData) this._onUpdateBaseActor({}, options);
      super._onUpdate(changes, options, userId);
    }

    get baseActor() {
      const data = this.flags?.[OBJECT_SCOPE]?.actorData;
      if (!data) return super.baseActor;
      let cached = baseActors.get(this);
      if (!cached || cached.data !== data) {
        cached = { data, actor: new CONFIG.Actor.documentClass(foundry.utils.deepClone(data)) };
        baseActors.set(this, cached);
      }
      return cached.actor;
    }
  };

  // dnd5e only applies token size sync to creatures, so repeat it for object actors.
  const BaseTokenObject = CONFIG.Token.objectClass;
  CONFIG.Token.objectClass = class ObjectToken extends BaseTokenObject {
    _refreshMeshSizeAndScale() {
      super._refreshMeshSizeAndScale();
      const actor = this.document.actor;
      if (!isObjectActor(actor) || !dnd5e.settings.tokenSizeSync || this.document.flags.dnd5e?.lockScale) return;
      const scale = CONFIG.DND5E.actorSizes[actor.system.traits?.size]?.dynamicTokenScale ?? 1;
      // Resizing (rather than scaling) keeps the result when the mesh texture is swapped.
      this.mesh.width *= scale;
      this.mesh.height *= scale;
    }
  };

  Hooks.on("preUpdateToken", (token, changes) => {
    if (!token.flags?.[OBJECT_SCOPE]?.actorData) return;
    const expanded = foundry.utils.expandObject(changes);
    if (expanded.flags?.[OBJECT_SCOPE]?.linkItemData === true) {
      const source = fromUuidSync(token.flags[OBJECT_SCOPE].itemUuid, { strict: false });
      if (!isObjectItem(source) || game.items.get(source.id) !== source || !source.isOwner) {
        ui.notifications.error(localize("ADVANCEDITEMS.LinkUnavailable"));
        return false;
      }
    }
    if (expanded.actorLink === true || ("actorId" in expanded && expanded.actorId !== token.actorId)) {
      ui.notifications.error(localize("ADVANCEDITEMS.Unlinked"));
      return false;
    }
  });

  Hooks.on("preUpdateItem", (item, changes) => {
    if (!isObjectItem(item)) return;
    const expanded = foundry.utils.expandObject(changes);
    let candidate = item;
    if (expanded.system?.type) {
      candidate = new CONFIG.Item.documentClass(item.toObject());
      candidate.updateSource(expanded);
    }
    if (!isMountable(candidate)) return;
    if (expanded.system?.armor && "value" in expanded.system.armor) {
      changes[`flags.${OBJECT_SCOPE}.object.ac`] = expanded.system.armor.value;
    } else if (expanded.system?.type?.value && item.flags?.[OBJECT_SCOPE]?.object?.ac !== undefined) {
      changes["system.armor.value"] = item.flags[OBJECT_SCOPE].object.ac;
    }
  });
}

export async function createObjectToken(item, data, event = {}) {
  if (!isObjectItem(item)) throw new Error("This item type cannot be placed as an object.");
  if (!game.user.can("TOKEN_CREATE") || !item.isOwner) {
    throw new Error(localize("ADVANCEDITEMS.Permission"));
  }
  if (!canvas.scene || !canvas.dimensions.rect.contains(data.x, data.y)) {
    throw new Error(localize("ADVANCEDITEMS.InvalidPosition"));
  }
  if (game.items.get(item.id) !== item) {
    if (!game.user.can("ITEM_CREATE")) throw new Error(localize("ADVANCEDITEMS.Permission"));
    const contents = await containedItemData(item);
    const source = [item, ...contents];
    const imported = remapItemIds(source.map(entry =>
      game.items.fromCompendium(entry, { clearFolder: true, keepId: true })));
    const created = await Item.implementation.createDocuments(imported, {
      keepId: true, fromCompendium: item.inCompendium
    });
    item = created[0];
    if (!item) throw new Error(localize("ADVANCEDITEMS.Failure"));
  }
  const actorData = await objectActorData(item);
  const actor = new CONFIG.Actor.documentClass(actorData);
  const token = await actor.getTokenDocument({
    actorId: actor.id,
    actorLink: false,
    // Materialize collections so server-side deltas never need a missing world Actor's items.
    delta: {
      items: foundry.utils.deepClone(actorData.items),
      effects: foundry.utils.deepClone(actorData.effects ?? [])
    },
    hidden: game.user.isGM && !!event.altKey,
    sort: Math.max(canvas.tokens.getMaxSort() + 1, 0),
    flags: { [OBJECT_SCOPE]: {
      itemUuid: item.uuid, actorData,
      linkItemData: item.flags?.[OBJECT_SCOPE]?.actor?.prototypeToken?.flags?.[OBJECT_SCOPE]?.linkItemData === true
    } }
  }, { parent: canvas.scene });
  const position = CONFIG.Token.objectClass._getDropActorPosition(token, {
    x: data.x, y: data.y, elevation: data.elevation
  }, { snap: !event.shiftKey });
  token.updateSource(position);
  canvas.tokens.activate();
  return CONFIG.Token.documentClass.create(token.toObject(), { parent: canvas.scene });
}

export async function addCargo(vehicle, item) {
  if (vehicle.type !== "vehicle" || !vehicle.isOwner || !isObjectItem(item) || !item.isOwner) {
    throw new Error(localize("ADVANCEDITEMS.Permission"));
  }
  const data = remapItemIds([item.toObject(), ...await containedItemData(item)]);
  for (const entry of data) setCargoState(entry, true);
  return vehicle.createEmbeddedDocuments("Item", data, { keepId: true });
}

function registerDrops() {
  Hooks.on("dropCanvasData", (_canvas, data, event) => {
    if (data.type !== "Item") return;
    // Hooks are synchronous; claim physical-item drops before starting asynchronous work.
    const resolved = data.uuid ? fromUuidSync(data.uuid, { strict: false }) : null;
    const type = resolved?.type ?? data.data?.type;
    if (type && !isObjectItemType(type)) return;
    const item = isObjectItem(resolved) ? resolved : null;
    if (!item && !data.uuid && !data.data) return;
    run(async () => {
      const dropped = item ?? await Item.implementation.fromDropData(data);
      if (!isObjectItem(dropped)) return;
      const vehicle = canvas.tokens.placeables.find(t => t.actor?.type === "vehicle" && t.bounds.contains(data.x, data.y));
      if (vehicle) await addCargo(vehicle.actor, dropped);
      else await createObjectToken(dropped, data, event);
    });
    return false;
  });

  Hooks.on("dropActorSheetData", (actor, _sheet, data) => {
    if (actor.type !== "vehicle" || data.type !== "Actor" || !data.uuid) return;
    const dropped = fromUuidSync(data.uuid);
    if (!isObjectActor(dropped)) return;
    run(() => addCargo(actor, dropped.items.get(dropped.flags[OBJECT_SCOPE].itemId)));
    return false;
  });
}

function configureToken(item) {
  if (!item.isOwner || !game.user.can("TOKEN_CONFIGURE")) throw new Error(localize("ADVANCEDITEMS.Permission"));
  if (isObjectActor(item.actor) && item.actor.token) {
    return item.actor.token.sheet.render({ force: true });
  }
  const actor = new CONFIG.Actor.documentClass(actorDataForItem(item));
  return new CONFIG.Token.prototypeSheetClass({ prototype: actor.prototypeToken }).render({ force: true });
}

function tokenControl(item) {
  const placed = isObjectActor(item.actor) && !!item.actor.token;
  return {
    icon: placed ? "fa-regular fa-circle-user" : "fa-solid fa-circle-user",
    label: placed ? "DOCUMENT.Token" : "TOKEN.TitlePrototype"
  };
}

const traitDialogs = new WeakMap();

const isEditable = sheet => sheet.document.isOwner
  && (sheet.isEditMode ?? !sheet.element.classList.contains("sheet-mode-play"));

function traitTitle(trait) {
  if (trait === "bypasses") return localize("DND5E.DAMAGE.PhysicalBypass.Label");
  if (trait === "dr") return localize("ADVANCEDITEMS.Resistances");
  if (trait === "dv") return localize("ADVANCEDITEMS.Vulnerabilities");
  return localize(CONFIG.DND5E.traits[trait].labels.title);
}

function traitChoices(trait) {
  if (trait === "bypasses") {
    return Object.entries(CONFIG.DND5E.itemProperties)
      .filter(([, property]) => property.isPhysical)
      .map(([key, property]) => [key, localize(property.label)]);
  }
  const config = CONFIG.DND5E.traits[trait];
  const choices = Object.entries(CONFIG.DND5E[config.configKey]);
  const all = trait === "ci"
    ? game.i18n.format("DND5E.TRAIT.All", { category: localize("DND5E.Conditions") })
    : config.labels.all;
  choices.unshift(["ALL", { label: all }]);
  return choices.map(([key, choice]) => [
    key, localize(choice[config.labelKeyPath ?? "label"] ?? choice.label ?? choice.name ?? key)
  ]);
}

function allSelected(value, trait) {
  return traitChoices(trait).every(([key]) => key === "ALL" || value.includes(key));
}

function traitPills(values, trait) {
  const captions = new Map(traitChoices(trait));
  const name = key => captions.get(key) ?? key;
  if (trait === "dm") {
    return Object.entries(values.dm.amount ?? {}).filter(([, formula]) => formula)
      .map(([key, formula]) => ({ label: name(key), value: formula }));
  }
  if (trait === "bypasses") {
    const selected = new Set(objectBypassTraits().flatMap(key => values[key].bypasses ?? []));
    return [...selected].map(key => ({ label: name(key) }));
  }
  const pills = values[trait].value.filter(key => key !== "ALL").map(key => ({ label: name(key) }));
  if (values[trait].custom) pills.push({ label: values[trait].custom });
  return pills;
}

function traitFieldset(trait, sheet, { title, hint, custom = false } = {}) {
  const tidy = sheet.element.classList.contains("tidy5e-sheet");
  const fieldset = document.createElement("fieldset");
  fieldset.className = custom ? "card" : "traits card";
  const legend = document.createElement("legend");
  legend.textContent = title;
  fieldset.append(legend);
  if (custom) {
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.objectTrait = trait;
    input.dataset.traitKey = "custom";
    input.setAttribute("aria-label", title);
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = localize("DND5E.SpecialHint");
    fieldset.append(input, note);
    return fieldset;
  }
  if (hint) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = localize(hint);
    fieldset.append(note);
  }
  const list = document.createElement("ol");
  list.className = "unlist trait-list";
  const bypass = trait === "bypasses";
  for (const [key, caption] of traitChoices(trait)) {
    const id = `${sheet.id}-object-${trait}-${key}`;
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.className = "name";
    label.textContent = caption;
    label.htmlFor = id;
    const proficiency = document.createElement("div");
    proficiency.className = "proficiency";
    let control;
    if (trait === "dm") {
      control = document.createElement("formula-input");
      control.setAttribute("context", "default");
    } else {
      control = document.createElement(tidy ? "input" : "dnd5e-checkbox");
      if (tidy) control.type = "checkbox";
    }
    control.dataset.objectTrait = bypass ? "bypasses" : trait;
    control.dataset.traitKey = key;
    control.id = id;
    control.setAttribute("aria-label", caption);
    proficiency.append(control);
    item.append(label, proficiency);
    list.append(item);
  }
  fieldset.append(list);
  return fieldset;
}

function buildTraitControls(trait, sheet) {
  const section = document.createElement("section");
  section.dataset.applicationPart = "traits";
  section.append(traitFieldset(trait, sheet, {
    title: traitTitle(trait),
    hint: trait === "dm" ? "DND5E.DamageModification.Hint"
      : trait === "bypasses" ? "DND5E.DAMAGE.PhysicalBypass.Hint" : null
  }));
  if (trait !== "ci" && trait !== "dm" && trait !== "bypasses") {
    section.append(traitFieldset(trait, sheet, { title: localize("DND5E.Special"), custom: true }));
  }
  return section;
}

function syncTraitControls(root, sheet) {
  const editable = isEditable(sheet);
  const values = objectProperties(sheet.document);
  const bypasses = new Set(objectBypassTraits().flatMap(trait => values.traits[trait].bypasses ?? []));
  for (const control of root.querySelectorAll("[data-object-trait]")) {
    control.disabled = !editable;
    const trait = control.dataset.objectTrait;
    const key = control.dataset.traitKey;
    if (trait === "bypasses") control.checked = bypasses.has(key);
    else if (trait === "dm" || key === "custom") {
      if (control !== document.activeElement && !control.contains(document.activeElement)) {
        const value = trait === "dm" ? values.traits.dm.amount[key] ?? "" : values.traits[trait].custom ?? "";
        if (control.value !== value) control.value = value;
      }
    } else control.checked = key === "ALL"
      ? allSelected(values.traits[trait].value, trait)
      : values.traits[trait].value.includes(key);
  }
}

function onTraitChange(event, sheet) {
  const input = event.target.closest("[data-object-trait]");
  if (!input) return;
  event.stopImmediatePropagation();
  const root = event.currentTarget;
  run(async () => {
    if (!isEditable(sheet)) throw new Error(localize("ADVANCEDITEMS.Permission"));
    const trait = input.dataset.objectTrait;
    const key = input.dataset.traitKey;
    const actor = isObjectActor(sheet.document.actor) ? sheet.document.actor
      : new CONFIG.Actor.documentClass(actorDataForItem(sheet.document));
    const updates = {};
    if (trait === "bypasses") {
      const selected = [...root.querySelectorAll('[data-object-trait="bypasses"]')]
        .filter(control => control.checked).map(control => control.dataset.traitKey);
      for (const damage of objectBypassTraits()) updates[`system.traits.${damage}.bypasses`] = selected;
    } else if (trait === "dm") {
      const formula = input.value.trim();
      updates[`system.traits.dm.amount.${key}`] = formula || new foundry.data.operators.ForcedDeletion();
    } else if (key === "custom") updates[`system.traits.${trait}.custom`] = input.value;
    else {
      const selected = new Set(objectProperties(sheet.document).traits[trait].value);
      selected.delete("ALL");
      if (key === "ALL") {
        const keys = traitChoices(trait).map(([choice]) => choice).filter(choice => choice !== "ALL");
        for (const choice of keys) {
          if (input.checked) selected.add(choice);
          else selected.delete(choice);
        }
      } else if (input.checked) selected.add(key);
      else selected.delete(key);
      updates[`system.traits.${trait}.value`] = [...selected];
    }
    await actor.update(updates);
    await sheet.render({ force: true });
  });
}

class ObjectTraitDialog extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["dnd5e2", "standard-form", "config-sheet", "trait-selector", "advanced-items-trait-dialog"],
    position: { width: 400 },
    window: { resizable: false }
  };

  constructor(sheet, trait) {
    super({ id: `${sheet.id}-object-traits-${trait}`, window: { title: traitTitle(trait) } });
    this.sheet = sheet;
    this.trait = trait;
  }

  async _renderHTML() {
    const body = buildTraitControls(this.trait, this.sheet);
    body.addEventListener("change", event => onTraitChange(event, this.sheet));
    return body;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.sync();
  }

  sync() {
    if (this.element) syncTraitControls(this.element, this.sheet);
  }

  async close(options) {
    traitDialogs.get(this.sheet)?.delete(this.trait);
    return super.close(options);
  }
}

function openTraitDialog(sheet, trait) {
  if (!traitDialogs.has(sheet)) traitDialogs.set(sheet, new Map());
  const dialogs = traitDialogs.get(sheet);
  const existing = dialogs.get(trait);
  if (existing) return existing.render({ force: true }).then(dialog => dialog.bringToFront());
  const offset = dialogs.size * 32;
  const dialog = new ObjectTraitDialog(sheet, trait);
  dialogs.set(trait, dialog);
  const { left, top, width } = sheet.position;
  const x = Math.min(left + width + 8, Math.max(0, window.innerWidth - dialog.options.position.width - 8));
  return dialog.render({ force: true, position: { left: x - offset, top: top + offset } }).then(() => dialog.bringToFront());
}

function appendTraitSummaries(section, sheet) {
  for (const trait of [...OBJECT_TRAITS, "bypasses"]) {
    const group = document.createElement("div");
    group.className = "pills-group";
    group.dataset.traitSummary = trait;
    const heading = document.createElement("h3");
    heading.className = "icon";
    const label = document.createElement("span");
    label.className = "roboto-upper";
    label.textContent = traitTitle(trait);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "config-button unbutton";
    button.dataset.traitConfig = trait;
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", game.i18n.format("DND5E.TRAIT.Action.Configure", { trait: label.textContent }));
    button.innerHTML = '<i class="fas fa-cog" inert></i>';
    heading.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      run(() => openTraitDialog(sheet, trait));
    });
    heading.append(label, button);
    const pills = document.createElement("ul");
    pills.className = "pills";
    group.append(heading, pills);
    section.append(group);
  }
}

function syncTraitSummaries(section, sheet) {
  const values = objectProperties(sheet.document).traits;
  for (const group of section.querySelectorAll("[data-trait-summary]")) {
    const entries = traitPills(values, group.dataset.traitSummary);
    group.querySelector(".pills").replaceChildren(...entries.map(({ label, value }) => {
      const pill = document.createElement("li");
      pill.className = "pill";
      const text = document.createElement("span");
      text.className = "label";
      text.textContent = label;
      pill.append(text);
      if (value) {
        const separator = document.createElement("span");
        separator.className = "separator";
        separator.textContent = "|";
        const amount = document.createElement("span");
        amount.className = "value";
        amount.textContent = value;
        pill.append(separator, amount);
      }
      return pill;
    }));
  }
  for (const dialog of traitDialogs.get(sheet)?.values() ?? []) dialog.sync();
}

function showArtwork(item, token = false) {
  const src = token
    ? (isObjectActor(item.actor) ? item.actor.token?.texture.src : null)
      ?? item.flags?.[OBJECT_SCOPE]?.actor?.prototypeToken?.texture?.src ?? item.img
    : item.img;
  return new foundry.applications.apps.ImagePopout({
    src, uuid: item.uuid, window: { title: item.name }
  }).render({ force: true });
}

function inputGroup(label, field, value, { text = false, top = false } = {}) {
  const group = document.createElement("div");
  group.className = `form-group${top ? " label-top" : ""}`;
  const caption = document.createElement("label");
  caption.textContent = localize(label);
  const fields = document.createElement("div");
  fields.className = "form-fields";
  const input = document.createElement("input");
  input.type = text ? "text" : "number";
  input.dataset.objectProperty = field;
  input.value = value;
  input.setAttribute("aria-label", localize(label));
  if (!text) {
    input.min = "0";
    input.step = "1";
  }
  fields.append(input);
  group.append(caption, fields);
  return group;
}

function refreshSheet(sheet) {
  const item = sheet.document;
  const root = sheet.element;
  if (!root?.isConnected || !isObjectItem(item)) return;
  const observer = observers.get(sheet);
  observer?.disconnect();
  try {
    const header = root.querySelector(".window-header");
    if (header) {
      let button = header.querySelector("[data-advanced-items-token]");
      if (!root.classList.contains("tidy5e-sheet") || !item.isOwner) button?.remove();
      else {
        const control = tokenControl(item);
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.dataset.advancedItemsToken = "";
          button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            run(() => configureToken(item));
          });
        }
        button.className = `header-control icon ${control.icon}`;
        button.dataset.tooltip = control.label;
        button.setAttribute("aria-label", localize(control.label));
        const uuid = header.querySelector('[data-action="copyUuid"]');
        if (uuid && button.nextElementSibling !== uuid) uuid.before(button);
      }
    }
    const details = root.querySelector('section[data-tab="details"], [data-tab-contents-for="details"]');
    if (!details) return;
    for (const fieldset of details.querySelectorAll("fieldset:not(.advanced-items-properties)")) {
      const hasCrew = fieldset.querySelector(
        '[name="system.crew.max"], [data-name="system.crew.max"], [data-tidy-field="system.crew.max"]'
      );
      if (!hasCrew) continue;
      for (const field of fieldset.querySelectorAll(
        '[name="system.armor.value"], [data-name="system.armor.value"], [data-tidy-field="system.armor.value"], '
        + '[name^="system.hp."], [data-name^="system.hp."], [data-tidy-field^="system.hp."]'
      )) {
        let group = field.closest(".form-group");
        while (group?.parentElement.closest(".form-group") && fieldset.contains(group.parentElement.closest(".form-group"))) {
          group = group.parentElement.closest(".form-group");
        }
        if (group) group.dataset.advancedItemsReplaced = "";
      }
    }
    let section = details.querySelector(".advanced-items-properties");
    if (!section) {
      const { ac, hp } = objectProperties(item);
      section = document.createElement("fieldset");
      section.className = "advanced-items-properties";
      const legend = document.createElement("legend");
      legend.textContent = localize("ADVANCEDITEMS.ObjectProperties");
      if (root.classList.contains("tidy5e-sheet")) {
        legend.append(document.createElement("tidy-gold-header-underline"));
      }
      section.append(legend, inputGroup("DND5E.ArmorClass", "ac", ac));
      const sizeGroup = document.createElement("div");
      sizeGroup.className = "form-group";
      const sizeLabel = document.createElement("label");
      sizeLabel.textContent = localize("DND5E.Size");
      const sizeFields = document.createElement("div");
      sizeFields.className = "form-fields";
      const size = document.createElement("select");
      size.dataset.objectProperty = "size";
      size.setAttribute("aria-label", localize("DND5E.Size"));
      for (const [value, config] of Object.entries(CONFIG.DND5E.actorSizes)) {
        size.add(new Option(localize(config.label), value));
      }
      sizeFields.append(size);
      sizeGroup.append(sizeLabel, sizeFields);
      section.append(sizeGroup);
      const hpGroup = document.createElement("div");
      hpGroup.className = "form-group split-group";
      const label = document.createElement("label");
      label.textContent = localize("DND5E.HitPoints");
      const fields = document.createElement("div");
      fields.className = "form-fields";
      fields.append(
        inputGroup("DND5E.Current", "hp.value", hp.value, { top: true }),
        inputGroup("DND5E.Max", "hp.max", hp.max, { top: true }),
        inputGroup("DND5E.Threshold", "hp.dt", hp.dt, { top: true })
      );
      hpGroup.append(label, fields);
      const conditions = document.createElement("input");
      conditions.type = "text";
      conditions.className = "full-width";
      conditions.dataset.objectProperty = "hp.conditions";
      conditions.value = hp.conditions;
      conditions.placeholder = localize("DND5E.VEHICLE.MOUNTABLE.FIELDS.hp.conditions.label");
      conditions.setAttribute("aria-label", localize("ADVANCEDITEMS.Conditions"));
      hpGroup.append(conditions);
      section.append(hpGroup);
      appendTraitSummaries(section, sheet);
      section.addEventListener("change", event => {
        const input = event.target.closest("[data-object-property]");
        if (!input) return;
        event.stopImmediatePropagation();
        run(async () => {
          const path = input.dataset.objectProperty;
          const value = input.type === "number" ? input.valueAsNumber : input.value;
          if (input.type === "number" && (!Number.isInteger(value) || value < 0)) {
            throw new Error(localize("ADVANCEDITEMS.InvalidNumber"));
          }
          if (path === "size" && !(value in CONFIG.DND5E.actorSizes)) throw new Error(localize("ADVANCEDITEMS.InvalidSize"));
          if (isObjectActor(item.actor)) {
            const key = path === "ac" ? "system.attributes.ac.override"
              : path === "size" ? "system.traits.size"
              : path === "hp.conditions" ? `flags.${OBJECT_SCOPE}.hpConditions` : `system.attributes.${path}`;
            await item.actor.update({ [key]: value });
            sheet.render({ force: true });
          } else {
            const updates = objectPropertyUpdate(item, path, value);
            if (path === "size" && !item.flags?.[OBJECT_SCOPE]?.actor?.prototypeToken?.flags?.dnd5e?.lockSize) {
              const dimension = tokenDimension(value);
              updates[`flags.${OBJECT_SCOPE}.actor.prototypeToken.width`] = dimension;
              updates[`flags.${OBJECT_SCOPE}.actor.prototypeToken.height`] = dimension;
            }
            await item.update(updates);
          }
        });
      });
      details.append(section);
    }
    const editable = isEditable(sheet);
    section.disabled = !editable && root.classList.contains("tidy5e-sheet");
    for (const control of section.querySelectorAll("input, select, button:not([data-trait-config]), dnd5e-checkbox, formula-input")) {
      control.disabled = !editable;
    }
    const values = objectProperties(item);
    for (const input of section.querySelectorAll("[data-object-property]")) {
      input.id = `${sheet.id}-object-${input.dataset.objectProperty.replaceAll(".", "-")}`;
      const label = input.closest(".form-group")?.querySelector(":scope > label");
      if ((input.type === "number" || input.tagName === "SELECT") && label) label.htmlFor = input.id;
      if (document.activeElement !== input) {
        input.value = foundry.utils.getProperty(values, input.dataset.objectProperty);
      }
    }
    syncTraitSummaries(section, sheet);
  } finally {
    observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled"] });
  }
}

function registerSheets() {
  Hooks.on("getHeaderControlsApplicationV2", (sheet, controls) => {
    if (!isObjectItem(sheet.document) || !sheet.document.isOwner) return;
    controls.push({
      action: "advancedItemsToken",
      ...tokenControl(sheet.document),
      onClick: () => run(() => configureToken(sheet.document))
    }, {
      action: "advancedItemsItemArtwork",
      icon: "fa-solid fa-image",
      label: "ADVANCEDITEMS.ViewItemArtwork",
      onClick: () => run(() => showArtwork(sheet.document))
    }, {
      action: "advancedItemsTokenArtwork",
      icon: "fa-solid fa-image",
      label: "SIDEBAR.TokenArt",
      onClick: () => run(() => showArtwork(sheet.document, true))
    });
  });
  Hooks.on("renderApplicationV2", sheet => {
    if (isObjectActor(sheet.actor)) {
      const represented = sheet.element.querySelector('[name="actorId"]');
      if (represented) {
        represented.replaceChildren(new Option(sheet.actor.name, sheet.actor.id, true, true));
        represented.disabled = true;
        const label = represented.closest(".form-group")?.querySelector("label");
        if (label) label.textContent = localize("ADVANCEDITEMS.RepresentedItem");
      }
      const link = sheet.element.querySelector('[name="actorLink"]');
      if (link) {
        const token = sheet.isPrototype ? sheet.token : sheet.document;
        const name = `flags.${OBJECT_SCOPE}.linkItemData`;
        link.name = name;
        link.checked = token.flags?.[OBJECT_SCOPE]?.linkItemData === true;
        link.disabled = !sheet.actor.isOwner || !game.user.can("TOKEN_CONFIGURE");
        const group = link.closest(".form-group");
        const label = group?.querySelector("label");
        if (label) label.textContent = localize("ADVANCEDITEMS.LinkItemData");
        let hint = group?.querySelector(".hint");
        if (group && !hint) {
          hint = document.createElement("p");
          hint.className = "hint";
          group.append(hint);
        }
        if (hint) hint.textContent = localize("ADVANCEDITEMS.LinkItemDataHint");
      }
    }
    if (!isObjectItem(sheet.document)) return;
    if (!observers.has(sheet)) {
      const observer = new MutationObserver(() => refreshSheet(sheet));
      observers.set(sheet, observer);
    }
    refreshSheet(sheet);
  });
  Hooks.on("closeApplicationV2", sheet => {
    observers.get(sheet)?.disconnect();
    observers.delete(sheet);
    for (const dialog of [...traitDialogs.get(sheet)?.values() ?? []]) dialog.close();
  });
  Hooks.on("updateActor", actor => {
    if (!isObjectActor(actor)) return;
    const sheet = actor.items.get(actor.flags[OBJECT_SCOPE].itemId)?.sheet;
    if (sheet?.rendered) refreshSheet(sheet);
  });
}

export function registerObjectItems() {
  registerDocuments();
  registerItemLinking();
  registerDrops();
  registerSheets();
}
