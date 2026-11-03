import {bindingMatches, isTransferHeld, onTransferChange, setTransferHeld, transferBindings} from "./controls.mjs";
import {assert, isPhysicalItem, localize, report, sourceForToken, transfer} from "./transfers.mjs";

let uninstall;

function getCanvasTokenPositions(session, point) {
  const destination = canvas.stage.toLocal(new PIXI.Point(point.clientX, point.clientY));
  const origin = session.data.origin;
  return Object.values(session.data.contexts).map(context => {
    const token = context.token.document;
    let position = {x: context.origin.x + destination.x - origin.x,
      y: context.origin.y + destination.y - origin.y, elevation: context.origin.elevation};
    if (!point.shiftKey) position = token.getSnappedPosition(position);
    return {token: context.token, position};
  });
}

function createTokenPreview(session) {
  const element = document.createElement("div");
  element.className = "advanced-drag-and-drop-preview advanced-drag-and-drop-token-preview";
  element.setAttribute("aria-hidden", "true");
  for (const {token} of Object.values(session.data.contexts)) {
    const container = new PIXI.Container();
    const sprite = container.addChild(new PIXI.Sprite(token.mesh.texture));
    sprite.anchor.copyFrom(token.mesh.anchor);
    sprite.scale.copyFrom(token.mesh.scale);
    sprite.rotation = token.mesh.rotation;
    sprite.tint = token.mesh.tint;
    let image;
    try { image = canvas.app.renderer.extract.canvas(container); }
    finally { container.destroy({children: true}); }
    image.dataset.tokenId = token.id;
    element.append(image);
  }
  return element;
}

function positionTokenPreview(session) {
  for (const {token, position} of getCanvasTokenPositions(session, session.point)) {
    const image = session.proxy.querySelector(`[data-token-id="${token.id}"]`);
    const bounds = token.mesh.getBounds();
    const current = canvas.stage.toGlobal(new PIXI.Point(token.document.x, token.document.y));
    const destination = canvas.stage.toGlobal(new PIXI.Point(position.x, position.y));
    image.style.left = `${destination.x + bounds.x - current.x}px`;
    image.style.top = `${destination.y + bounds.y - current.y}px`;
    image.style.width = `${bounds.width}px`;
    image.style.height = `${bounds.height}px`;
  }
}

async function moveCanvasTokens(session, point) {
  const positions = getCanvasTokenPositions(session, point);
  const destination = canvas.stage.toLocal(new PIXI.Point(point.clientX, point.clientY));
  assert(positions.length && canvas.dimensions.rect.contains(destination.x, destination.y));
  const moves = {};
  for (const {token: object, position} of positions) {
    const token = object.document;
    assert(token.isOwner && token.parent === canvas.scene, "Permission");
    moves[token.id] = {destination: {...position, action: "displace", snapped: !point.shiftKey}};
  }
  const results = await canvas.scene.moveTokens(moves, {
    animate: false, constrainOptions: {ignoreWalls: true, ignoreCost: true}
  });
  assert(Object.values(results).every(Boolean), "Failed");
}

function sheetAt(element) {
  if (!(element instanceof HTMLElement)) return null;
  return [...foundry.applications.instances.values()].filter(app => app.rendered
    && app.element?.ownerDocument === document && app.element.contains(element)
    && (app.document?.documentName === "Actor" || app.document?.type === "container"))
    .sort((first, second) => first.element.contains(second.element) ? 1 : -1)[0] ?? null;
}

function sheetSource(element) {
  const app = sheetAt(element);
  if (!app || element.closest(".window-header,button,input,select,textarea,[contenteditable=true]")) return null;
  const row = element.closest("[data-item-id], [data-uuid]");
  if (!row) return null;
  const vehicle = app.actor ?? app.document;
  const area = row.closest("[data-area]")?.dataset.area;
  const actor = row.dataset.uuid ? fromUuidSync(row.dataset.uuid, {strict: false}) : null;
  if (vehicle.type === "vehicle" && ["crew", "passengers"].includes(area)
    && actor?.documentName === "Actor") {
    return {kind: "crew", actor, vehicle, area, uuid: `${vehicle.uuid}.${area}.${actor.uuid}`,
      payload: {type: "Actor", uuid: actor.uuid, area}, app, element: row};
  }
  const item = app.inventorySource?.items?.get(row.dataset.itemId)
    ?? app.actor?.items.get(row.dataset.itemId) ?? game.items.get(row.dataset.itemId);
  if (!isPhysicalItem(item)) return null;
  return {kind: "item", item, uuid: item.uuid, payload: item.toDragData(), app, element: row};
}

function targetAt(element, sources, point) {
  const app = sheetAt(element);
  if (app) {
    const doc = app.document;
    const actor = doc.documentName === "Actor" ? app.inventorySource ?? doc : doc.actor;
    const creatures = sources.every(source => source.kind === "actor");
    if (creatures) {
      const zone = element.closest('[data-area="crew"], [data-area="passengers"]');
      if (actor?.type !== "vehicle" || !zone || !actor.isOwner) return null;
      return {kind: "crew", actor, area: zone.dataset.area, app, element: zone};
    }
    if (!sources.every(source => source.kind === "item")) return null;
    if (element.closest('[data-area="crew"], [data-area="passengers"], [data-area="draft"]')) return null;
    let container = doc.type === "container" && doc.documentName === "Item" ? doc : null;
    const itemRow = element.closest("[data-item-id]");
    const candidate = actor?.items.get(itemRow?.dataset.itemId);
    const containerRow = candidate?.type === "container" ? itemRow : element.closest(".container[data-item-id]");
    if (containerRow) container = actor?.items.get(containerRow.dataset.itemId) ?? container;
    if (!(actor ?? container)?.isOwner) return null;
    return {kind: "inventory", actor, container, app, element: containerRow ?? app.element};
  }
  if (element !== canvas.app?.view && element?.closest?.("#board") !== canvas.app?.view) return null;
  if (!sources.every(source => source.kind === "item" || source.kind === "crew")) return null;
  const position = canvas.stage.toLocal(new PIXI.Point(point.clientX, point.clientY));
  if (!canvas.dimensions.rect.contains(position.x, position.y)) return null;
  const vehicle = sources.every(source => source.kind === "item")
    ? canvas.tokens.placeables.find(token => token.actor?.type === "vehicle"
      && token.bounds.contains(position.x, position.y)) : null;
  if (vehicle) return vehicle.actor.isOwner
    ? {kind: "inventory", actor: vehicle.actor, element: canvas.app.view} : null;
  return {kind: "canvas", scene: canvas.scene, x: position.x, y: position.y,
    elevation: canvas.tokens.hover?.document.elevation ?? 0, shiftKey: point.shiftKey,
    altKey: point.altKey, element: canvas.app.view};
}

function dropEvent(element, point, payload) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", JSON.stringify(payload));
  const event = new DragEvent("drop", {bubbles: true, cancelable: true, dataTransfer,
    clientX: point.clientX, clientY: point.clientY, shiftKey: point.shiftKey,
    ctrlKey: point.ctrlKey, altKey: point.altKey, metaKey: point.metaKey});
  Object.defineProperty(event, "target", {value: element});
  return event;
}

async function nativeSheetDrop(source, element, point) {
  const app = sheetAt(element);
  const event = dropEvent(element, point, source.payload);
  if (!app) {
    if (element === canvas.app?.view || element?.closest?.("#board")) canvas.app.view.dispatchEvent(event);
    return;
  }
  const over = {type: "dragover", shiftKey: point.shiftKey, ctrlKey: point.ctrlKey,
    altKey: point.altKey, metaKey: point.metaKey, dataTransfer: event.dataTransfer,
    target: element, currentTarget: app.element};
  event._behavior = app._dropBehavior?.(over, source.payload) ?? "copy";
  const doc = app.actor ?? app.document;
  if (doc.documentName === "Actor"
    && Hooks.call("dropActorSheetData", doc, app, source.payload) === false) return;
  if (source.kind === "item") return app._onDropItem?.(event, source.item);
  return app._onDropActor?.(event, source.actor);
}

export function installDragBridge() {
  if (uninstall) return uninstall;
  let active;
  let pending;
  let highlighted;
  let suppressClick = false;
  let clickTimer;
  let bindingSignature = JSON.stringify(transferBindings());
  const keys = new Set(game.keyboard.downKeys);
  const abort = new AbortController();
  const options = {capture: true, signal: abort.signal};
  const prototype = CONFIG.Token.objectClass.prototype;
  const originals = new Map();
  const tokenCallbacks = new Map();
  const clearHighlight = () => {
    highlighted?.classList.remove("advanced-drag-and-drop-target");
    highlighted = null;
  };
  const cleanup = () => {
    const session = active;
    active = null;
    pending = null;
    clearHighlight();
    session?.proxy?.remove();
    for (const source of session?.sources ?? []) source.element?.classList.remove("advanced-drag-and-drop-source");
    if (session?.native) session.native.layer.preview.renderable = session.previewRenderable;
    return session;
  };
  const cancel = () => {
    const session = cleanup();
    if (!session?.native) return;
    session.data.cancelled = true;
    session.native.mouseInteractionManager.cancel();
  };
  const bindingChanged = () => {
    const signature = JSON.stringify(transferBindings());
    if (signature === bindingSignature) return false;
    bindingSignature = signature;
    cancel();
    keys.clear();
    setTransferHeld(false);
    return true;
  };
  const preventClick = () => {
    suppressClick = true;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 0);
  };
  const commitTransfer = (session, element, point) => {
    if (session.native && element === canvas.app.view) {
      void moveCanvasTokens(session, point).catch(report);
      return;
    }
    const target = targetAt(element, session.sources, point);
    if (target) void transfer(session.sources, target).catch(report);
    else ui.notifications.warn(localize("Invalid"));
  };
  const visual = () => {
    if (!active) return;
    clearHighlight();
    const held = isTransferHeld();
    for (const source of active.sources) source.element?.classList.toggle("advanced-drag-and-drop-source", held);
    if (active.native) active.native.layer.preview.renderable = held ? false : active.previewRenderable;
    if (!held && active.native) {
      active.proxy?.remove();
      active.proxy = null;
      return;
    }
    if (!active.proxy) {
      if (active.native) active.proxy = createTokenPreview(active);
      else {
        active.proxy = document.createElement("img");
        active.proxy.className = "advanced-drag-and-drop-preview";
        active.proxy.alt = "";
        active.proxy.src = active.sources[0].item?.img ?? active.sources[0].actor?.img ?? "icons/svg/item-bag.svg";
      }
      document.body.append(active.proxy);
    }
    if (active.native) positionTokenPreview(active);
    else {
      active.proxy.style.left = `${active.point.clientX + 12}px`;
      active.proxy.style.top = `${active.point.clientY + 12}px`;
    }
    const element = document.elementFromPoint(active.point.clientX, active.point.clientY);
    const target = targetAt(element, active.sources, active.point);
    if (held && target) {
      highlighted = target.element;
      highlighted.classList.add("advanced-drag-and-drop-target");
    }
  };
  const wrap = (name, callback) => {
    const own = Object.getOwnPropertyDescriptor(prototype, name);
    const original = prototype[name];
    originals.set(name, {own, original});
    prototype[name] = function(...args) { return callback.call(this, original, ...args); };
  };
  wrap("_initializeDragLeft", function(original, event) {
    const result = original.call(this, event);
    cleanup();
    const tokens = Object.values(event.interactionData.contexts ?? {}).map(context => context.token.document);
    if (!tokens.length) return result;
    active = {native: this, data: event.interactionData, sources: tokens.map(sourceForToken),
      previewRenderable: this.layer.preview.renderable, point: event};
    visual();
    return result;
  });
  wrap("_onDragLeftMove", function(original, event) {
    if (active?.native === this && isTransferHeld()) return;
    return original.call(this, event);
  });
  wrap("_onDragLeftDrop", function(original, event) {
    if (active?.native !== this) return original.call(this, event);
    if (bindingChanged()) return true;
    const point = active.point;
    const element = document.elementFromPoint(point.clientX, point.clientY);
    const held = isTransferHeld();
    if (!held && element === canvas.app.view) return original.call(this, event);
    const session = active;
    session.data.cancelled = true;
    preventClick();
    cleanup();
    if (held) queueMicrotask(() => commitTransfer(session, element, point));
    return true;
  });
  wrap("_finalizeDragLeft", function(original, event) {
    if (active?.native === this) cleanup();
    return original.call(this, event);
  });
  const bindToken = token => {
    const callbacks = token.mouseInteractionManager?.callbacks;
    if (!callbacks || tokenCallbacks.get(token)?.callbacks === callbacks) return;
    tokenCallbacks.set(token, {callbacks, move: callbacks.dragLeftMove, drop: callbacks.dragLeftDrop});
    callbacks.dragLeftMove = event => token._onDragLeftMove(event);
    callbacks.dragLeftDrop = event => token._onDragLeftDrop(event);
  };
  for (const token of canvas.tokens?.placeables ?? []) bindToken(token);
  const drawHook = Hooks.on("drawToken", bindToken);
  const destroyHook = Hooks.on("destroyToken", token => tokenCallbacks.delete(token));
  document.addEventListener("pointerdown", event => {
    suppressClick = false;
    if (event.button !== 0 || active) return;
    const source = sheetSource(event.target);
    if (source) pending = {source, point: event};
  }, options);
  document.addEventListener("dragstart", event => {
    if (!pending && !active?.sheet) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!active) {
      active = {sheet: true, sources: [pending.source], point: pending.point};
      pending = null;
      visual();
    }
  }, options);
  document.addEventListener("pointermove", event => {
    if (bindingChanged()) return;
    if (pending && !active && (event.buttons & 1)
      && Math.hypot(event.clientX - pending.point.clientX, event.clientY - pending.point.clientY) >= 8) {
      active = {sheet: true, sources: [pending.source], point: event};
      pending = null;
      game.tooltip.deactivate();
    }
    if (!active) return;
    active.point = event;
    visual();
    if (active.sheet) event.preventDefault();
  }, options);
  document.addEventListener("pointerup", event => {
    pending = null;
    if (bindingChanged()) return;
    if (!active || event.button !== 0) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const held = isTransferHeld();
    if (active.native && !held && element === canvas.app.view) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    preventClick();
    const session = active;
    cancel();
    if (held) commitTransfer(session, element, event);
    else if (session.sheet) void nativeSheetDrop(session.sources[0], element, event).catch(report);
  }, options);
  const keyChange = event => {
    if (bindingChanged()) return;
    if (event.type === "keydown") keys.add(event.code);
    else keys.delete(event.code);
    if (event.key === "Escape" && active) {
      cancel();
      setTransferHeld(false);
      return;
    }
    if (!active && event.target.closest?.("input,textarea,select,[contenteditable=true]")) return;
    setTransferHeld(bindingMatches(keys, event));
    if (active && isTransferHeld()) event.preventDefault();
  };
  document.addEventListener("keydown", keyChange, options);
  document.addEventListener("keyup", keyChange, options);
  document.addEventListener("click", event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, options);
  document.addEventListener("contextmenu", () => { if (active) cancel(); }, options);
  document.addEventListener("pointercancel", () => { cancel(); setTransferHeld(false); }, options);
  window.addEventListener("blur", () => { keys.clear(); cancel(); setTransferHeld(false); }, {signal: abort.signal});
  const off = onTransferChange(visual);
  const hook = Hooks.on("canvasTearDown", cancel);
  uninstall = () => {
    cancel();
    setTransferHeld(false);
    off();
    abort.abort();
    clearTimeout(clickTimer);
    Hooks.off("canvasTearDown", hook);
    Hooks.off("drawToken", drawHook);
    Hooks.off("destroyToken", destroyHook);
    for (const {callbacks, move, drop} of tokenCallbacks.values()) {
      callbacks.dragLeftMove = move;
      callbacks.dragLeftDrop = drop;
    }
    tokenCallbacks.clear();
    for (const [name, {own, original}] of originals) {
      if (own) Object.defineProperty(prototype, name, own);
      else {
        delete prototype[name];
        if (prototype[name] !== original) console.warn("Advanced Drag & Drop | Token wrapper changed during teardown.");
      }
    }
    uninstall = undefined;
  };
  return uninstall;
}