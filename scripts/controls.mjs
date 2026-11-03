export const MODULE_ID = "advanced-drag-and-drop";
export const DEFAULT_KEY = "KeyV";

let held = false;
const listeners = new Set();

export function isTransferHeld() {
  return held;
}

export function setTransferHeld(value) {
  if (held === value) return;
  held = value;
  for (const listener of listeners) listener(value);
}

export function onTransferChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerTransferBinding() {
  game.keybindings.register(MODULE_ID, "transferModifier", {
    name: "ADVANCED_DRAG_DROP.Controls.Name",
    editable: [{key: DEFAULT_KEY}],
    reservedModifiers: ["Shift"],
    onDown: () => { setTransferHeld(true); return false; },
    onUp: () => { setTransferHeld(false); return false; }
  });
}

export function transferBindings() {
  return game.keybindings.actions.has(`${MODULE_ID}.transferModifier`)
    ? game.keybindings.get(MODULE_ID, "transferModifier") : [{key: DEFAULT_KEY}];
}

export function bindingMatches(keys, event = {}, bindings = transferBindings()) {
  const modifiers = {
    shift: event.shiftKey ?? (keys.has("ShiftLeft") || keys.has("ShiftRight")),
    control: event.ctrlKey || event.metaKey || keys.has("ControlLeft") || keys.has("ControlRight")
      || keys.has("MetaLeft") || keys.has("MetaRight"),
    alt: event.altKey ?? (keys.has("AltLeft") || keys.has("AltRight")),
    meta: event.metaKey ?? (keys.has("MetaLeft") || keys.has("MetaRight"))
  };
  return bindings.some(binding => {
    if (!keys.has(binding.key)) return false;
    const required = new Set((binding.modifiers ?? []).map(modifier => modifier.toLowerCase()));
    const primary = binding.key.startsWith("Shift") ? "shift" : binding.key.startsWith("Alt") ? "alt"
      : /^(Control|Meta|Os|OS)/.test(binding.key) ? "control" : null;
    return [...required].every(modifier => modifiers[modifier])
      && ["shift", "control", "alt"].every(modifier => !modifiers[modifier]
        || modifier === "shift" || required.has(modifier) || modifier === primary);
  });
}