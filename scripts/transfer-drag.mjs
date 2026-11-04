import {bindingMatches, isTransferHeld, onTransferChange, setTransferHeld, transferBindings} from "./controls.mjs";
import {assert, isPhysicalItem, localize, report, sourceForToken, transfer} from "./transfers.mjs";

let uninstall;

function canvasPosition(point) {
  return canvas.stage.toLocal(new PIXI.Point(point.clientX, point.clientY));
}

function updateNativePreview(session) {
  session.native._updateDragDestination(canvasPosition(session.point), {snap: !session.point.shiftKey});
}

function getCanvasTokenPositions(session, point) {
  const destination = canvasPosition(point);
  const origin = session.native._getDragOrigin();
  return Object.values(session.data.contexts).map(context => {
    const token = context.token.document;
    const position = context.token._getDragWaypointPosition(context.origin, {
      x: token._source.x + destination.x - origin.x,
      y: token._source.y + destination.y - origin.y, elevation: context.origin.elevation
    }, {snap: !point.shiftKey && !canvas.grid.isGridless});
    return {token: context.token, position};
  });
}

function createTokenPreview() {
  const element = document.createElement("div");
  element.className = "advanced-drag-and-drop-preview advanced-drag-and-drop-token-preview";
  element.setAttribute("aria-hidden", "true");
  return element;
}

function updateTransferClones(session) {
  for (const {token, position} of getCanvasTokenPositions(session, session.point)) {
    const clone = session.data.contexts[token.id].clonedToken;
    const refreshPosition = clone.document.x !== position.x || clone.document.y !== position.y;
    const refreshElevation = clone.document.elevation !== position.elevation;
    Object.assign(clone.document, position);
    clone.renderFlags.set({refreshPosition, refreshElevation});
    clone.applyRenderFlags();
  }
}

function captureTokenPreview(clone) {
  // Render the actual mesh and decorations in place so primary-group shaders and transforms stay intact.
  const container = new PIXI.Container();
  const objects = [clone.mesh, clone].map(object => ({object, cullable: object.cullable}));
  const screenBounds = clone.mesh.getBounds().clone();
  screenBounds.enlarge(clone.getBounds());
  container.render = renderer => {
    // Decorations can query mesh bounds and change its cached vertices before a batch is flushed.
    for (const {object} of objects) {
      object.render(renderer);
      renderer.batch.flush();
    }
  };
  let texture;
  try {
    for (const {object} of objects) object.cullable = false;
    const renderer = canvas.app.renderer;
    texture = PIXI.RenderTexture.create({width: screenBounds.width, height: screenBounds.height,
      resolution: renderer.resolution, multisample: renderer.multisample});
    renderer.render(container, {renderTexture: texture,
      transform: new PIXI.Matrix().translate(-screenBounds.x, -screenBounds.y),
      skipUpdateTransform: true, blit: true});
    const image = renderer.extract.canvas(texture);
    const topLeft = canvas.stage.toLocal(new PIXI.Point(screenBounds.x, screenBounds.y));
    const bounds = new PIXI.Rectangle(topLeft.x, topLeft.y,
      screenBounds.width / canvas.stage.scale.x, screenBounds.height / canvas.stage.scale.y);
    return {image, bounds};
  } finally {
    for (const {object, cullable} of objects) object.cullable = cullable;
    container.destroy();
    texture?.destroy(true);
  }
}

function restoreTokenPreviews(session) {
  for (const {clone, renderable, meshRenderable} of session.previews.values()) {
    if (clone.destroyed) continue;
    clone.renderable = renderable;
    clone.mesh.renderable = meshRenderable;
    clone.renderFlags.set({refreshVisibility: true});
    clone.applyRenderFlags();
  }
}

function updateRulerVisibility(session, transferring) {
  for (const {token, clonedToken} of Object.values(session.data.contexts)) {
    for (const object of [token, clonedToken]) {
      if (!object.destroyed && object.ruler) {
        object.ruler.visible = transferring ? false : object.ruler.isVisible;
      }
    }
  }
}

function positionTokenPreview(session, floating) {
  const scale = canvas.stage.scale;
  for (const [id, entry] of session.previews) {
    if (session.data.contexts[id]) continue;
    entry.image?.remove();
    session.previews.delete(id);
  }
  for (const {token, clonedToken: clone} of Object.values(session.data.contexts)) {
    if (!clone.mesh || !clone.visible) continue;
    clone.applyRenderFlags();
    let entry = session.previews.get(token.id);
    if (!entry) {
      entry = {clone, renderable: clone.renderable, meshRenderable: clone.mesh.renderable};
      session.previews.set(token.id, entry);
    }
    if (floating && !entry.image) {
      Object.assign(entry, captureTokenPreview(clone));
      entry.offset = {x: entry.bounds.x - clone.document.x, y: entry.bounds.y - clone.document.y};
      session.proxy.append(entry.image);
    }
    const renderable = floating ? false : entry.renderable;
    const refreshVisibility = clone.renderable !== renderable;
    clone.renderable = renderable;
    clone.mesh.renderable = floating ? false : entry.meshRenderable;
    if (refreshVisibility) {
      clone.renderFlags.set({refreshVisibility: true});
      clone.applyRenderFlags();
    }
    if (entry.image) {
      entry.image.hidden = !floating;
      const topLeft = canvas.stage.toGlobal(new PIXI.Point(
        clone.document.x + entry.offset.x, clone.document.y + entry.offset.y));
      Object.assign(entry.image.style, {
        left: `${topLeft.x}px`, top: `${topLeft.y}px`,
        width: `${entry.bounds.width * scale.x}px`, height: `${entry.bounds.height * scale.y}px`
      });
    }
  }
}

async function moveCanvasTokens(session, point) {
  const positions = getCanvasTokenPositions(session, point);
  const destination = canvasPosition(point);
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
  const position = canvasPosition(point);
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
    if (session?.native) {
      restoreTokenPreviews(session);
      updateRulerVisibility(session, false);
    }
    if (session?.ticker) canvas.app.ticker.remove(session.ticker);
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
    if (active.native) {
      if (held) updateTransferClones(active);
      else if (active.held) {
        // Native movement was suppressed in transfer mode; resume at the current cursor immediately.
        updateNativePreview(active);
      }
      active.held = held;
      updateRulerVisibility(active, held);
    }
    if (!held && active.native) {
      restoreTokenPreviews(active);
      active.proxy?.remove();
      active.proxy = null;
      active.previews.clear();
      return;
    }
    if (!active.proxy) {
      if (active.native) active.proxy = createTokenPreview();
      else {
        active.proxy = document.createElement("img");
        active.proxy.className = "advanced-drag-and-drop-preview";
        active.proxy.alt = "";
        active.proxy.src = active.sources[0].item?.img ?? active.sources[0].actor?.img ?? "icons/svg/item-bag.svg";
      }
      document.body.append(active.proxy);
    }
    const element = document.elementFromPoint(active.point.clientX, active.point.clientY);
    if (active.native) {
      const floating = Boolean(sheetAt(element));
      if (!floating) {
        for (const entry of active.previews.values()) {
          entry.image?.remove();
          delete entry.image;
        }
      }
      positionTokenPreview(active, floating);
    }
    else {
      active.proxy.style.left = `${active.point.clientX + 12}px`;
      active.proxy.style.top = `${active.point.clientY + 12}px`;
    }
    const target = targetAt(element, active.sources, active.point);
    if (held && target) {
      highlighted = target.element;
      highlighted.classList.add("advanced-drag-and-drop-target");
    }
  };
  const refreshVisual = () => {
    try { visual(); }
    catch (error) {
      cancel();
      report(error);
    }
  };
  const wrap = (name, callback) => {
    const own = Object.getOwnPropertyDescriptor(prototype, name);
    const original = prototype[name];
    originals.set(name, {own, original});
    prototype[name] = function(...args) { return callback.call(this, original, ...args); };
  };
  wrap("_refreshState", function(original, ...args) {
    const result = original.apply(this, args);
    if (active?.native && isTransferHeld() && this.ruler
      && Object.values(active.data.contexts).some(context => context.token === this || context.clonedToken === this)) {
      this.ruler.visible = false;
    }
    return result;
  });
  wrap("_initializeDragLeft", function(original, event) {
    const result = original.call(this, event);
    cleanup();
    const tokens = Object.values(event.interactionData.contexts ?? {}).map(context => context.token.document);
    if (!tokens.length) return result;
    active = {native: this, data: event.interactionData, sources: tokens.map(sourceForToken),
      previews: new Map(), held: false, point: event};
    active.ticker = () => { if (isTransferHeld()) refreshVisual(); };
    canvas.app.ticker.add(active.ticker, undefined, PIXI.UPDATE_PRIORITY.OBJECTS - 1);
    refreshVisual();
    return result;
  });
  wrap("_onDragLeftMove", function(original, event) {
    if (active?.native === this) {
      // Foundry can emulate movement using an older canvas event while the cursor is over UI.
      // The document pointer listener is authoritative, including modifier changes.
      if (isTransferHeld()) {
        refreshVisual();
        if (!active) return;
        if (document.elementFromPoint(active.point.clientX, active.point.clientY) === canvas.app.view) {
          canvas._onDragCanvasPan(event);
        }
        return;
      }
      if (event.clientX !== active.point.clientX || event.clientY !== active.point.clientY
        || event.shiftKey !== active.point.shiftKey) {
        updateNativePreview(active);
        return;
      }
    }
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
      refreshVisual();
    }
  }, options);
  document.addEventListener("pointermove", event => {
    // Foundry dispatches synthetic pointermoves from its last canvas event, which can be stale over sheets.
    if (active?.native && !event.isTrusted) return;
    if (bindingChanged()) return;
    if (pending && !active && (event.buttons & 1)
      && Math.hypot(event.clientX - pending.point.clientX, event.clientY - pending.point.clientY) >= 8) {
      active = {sheet: true, sources: [pending.source], point: event};
      pending = null;
      game.tooltip.deactivate();
    }
    if (!active) return;
    active.point = event;
    refreshVisual();
    if (active?.sheet) event.preventDefault();
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
    if (active) active.point = {clientX: active.point.clientX, clientY: active.point.clientY,
      shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey};
    setTransferHeld(bindingMatches(keys, event));
    refreshVisual();
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
  const off = onTransferChange(refreshVisual);
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