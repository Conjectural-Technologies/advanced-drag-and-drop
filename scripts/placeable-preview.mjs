import {isTransferHeld, onTransferChange} from "./controls.mjs";
import {report} from "./transfers.mjs";

export function installPlaceableTransferPreviews(createPreview) {
  const prototype = foundry.canvas.placeables.PlaceableObject.prototype;
  const initialize = prototype._initializeDragLeft;
  const finalize = prototype._finalizeDragLeft;
  const abort = new AbortController();
  let session;

  function clearPreview() {
    if (!session?.preview) return;
    for (const entry of session.entries) {
      for (const {object, renderable} of entry.objects) if (!object.destroyed) object.renderable = renderable;
    }
    session.preview.remove();
    session.preview = null;
    session.entries = [];
  }

  function stop() {
    if (!session) return;
    clearPreview();
    canvas.app?.ticker.remove(session.ticker);
    session = null;
  }

  function capture(clone) {
    const objects = [...new Set([clone.mesh, clone.shape, clone])].filter(object => object && !object.destroyed
      && typeof object.render === "function" && object.renderable && (object === clone || object.parent !== clone));
    if (!objects.length) return null;
    const bounds = objects[0].getBounds().clone();
    for (const object of objects.slice(1)) bounds.enlarge(object.getBounds());
    if (!(bounds.width > 0 && bounds.height > 0)) return null;
    const renderer = canvas.app.renderer;
    const container = new PIXI.Container();
    const states = objects.map(object => ({object, renderable: object.renderable, cullable: object.cullable}));
    container.render = current => {
      for (const {object} of states) {
        object.render(current);
        current.batch.flush();
      }
    };
    let texture;
    try {
      for (const {object} of states) object.cullable = false;
      texture = PIXI.RenderTexture.create({width: bounds.width, height: bounds.height,
        resolution: renderer.resolution, multisample: renderer.multisample});
      renderer.render(container, {renderTexture: texture,
        transform: new PIXI.Matrix().translate(-bounds.x, -bounds.y), skipUpdateTransform: true, blit: true});
      const image = renderer.extract.canvas(texture);
      return {clone, image, bounds, objects: states};
    } finally {
      for (const {object, cullable} of states) object.cullable = cullable;
      container.destroy();
      texture?.destroy(true);
    }
  }

  function update() {
    if (!session) return;
    if (!isTransferHeld()) {
      clearPreview();
      session.failed = false;
      return;
    }
    if (session.failed) return;
    try {
      for (const clone of session.clones) {
        if (clone.destroyed || !clone.visible || session.entries.some(entry => entry.clone === clone)) continue;
        clone.applyRenderFlags?.();
        const entry = capture(clone);
        if (!entry) continue;
        session.preview ??= createPreview();
        entry.pointer = {x: session.point.clientX, y: session.point.clientY};
        const rect = canvas.app.view.getBoundingClientRect();
        entry.left = entry.bounds.x + rect.left;
        entry.top = entry.bounds.y + rect.top;
        session.entries.push(entry);
        session.preview.append(entry.image);
        for (const {object} of entry.objects) object.renderable = false;
      }
      for (const entry of session.entries) {
        for (const {object} of entry.objects) if (!object.destroyed) object.renderable = false;
        Object.assign(entry.image.style, {
          left: `${entry.left + session.point.clientX - entry.pointer.x}px`,
          top: `${entry.top + session.point.clientY - entry.pointer.y}px`,
          width: `${entry.bounds.width}px`, height: `${entry.bounds.height}px`
        });
      }
    } catch (error) {
      clearPreview();
      session.failed = true;
      report(error);
    }
  }

  prototype._initializeDragLeft = function(event) {
    const result = initialize.call(this, event);
    if (this.document?.documentName === "Token") return result;
    stop();
    const clones = event.interactionData.clones ?? [];
    if (!clones.length) return result;
    session = {object: this, clones, point: event, entries: [], preview: null, ticker: update};
    canvas.app.ticker.add(update, undefined, PIXI.UPDATE_PRIORITY.OBJECTS - 1);
    return result;
  };
  prototype._finalizeDragLeft = function(event) {
    if (session?.object === this) stop();
    return finalize.call(this, event);
  };
  document.addEventListener("pointermove", event => {
    if (!session || !event.isTrusted) return;
    session.point = event;
    update();
  }, {capture: true, signal: abort.signal});
  for (const name of ["pointerup", "pointercancel"]) document.addEventListener(name, stop, {capture: true, signal: abort.signal});
  window.addEventListener("blur", stop, {signal: abort.signal});
  const off = onTransferChange(update);
  const hook = Hooks.on("canvasTearDown", stop);
  return () => {
    stop();
    off();
    abort.abort();
    Hooks.off("canvasTearDown", hook);
    prototype._initializeDragLeft = initialize;
    prototype._finalizeDragLeft = finalize;
  };
}