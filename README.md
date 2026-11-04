# Advanced Drag & Drop

**Release:** 2.0.0.

Smarter dragging and dropping for D&D 5e in Foundry VTT v14. Move items and creatures between sheets, containers, vehicles and the canvas, and place physical items on the map as **object tokens** with their own hit points, armour class and damage traits.

**Requirements:** Foundry VTT v14 and the D&D 5e system 6.0.6 or newer.

Physical item support follows D&D 5e's quantity/container schema, mountable status follows its data-model getters, and token dimensions and physical bypass options use the system's size and trait definitions.

## Installation

In Foundry's **Add-on Modules** tab choose **Install Module** and paste this manifest URL:

```
https://github.com/Conjectural-Technologies/advanced-drag-and-drop/releases/latest/download/module.json
```

## Features

### Transfer by dragging
Hold the **Transfer** key (default <kbd>V</kbd>, rebindable under **Configure Controls**) while dragging to move something instead of copying it.

- **Items** move between actor, container and vehicle sheets, and onto the canvas.
- **Creatures** can be dragged from the canvas onto a vehicle's crew or passengers. Dragging them back out restores their saved token.
- **Stacks** prompt for how many to move.
- **Containers** move with their contents.
- **Safe by design:** ownership and permissions are checked, transfers are rolled back on failure, and moving items into a vehicle marks them as cargo and unequips them.
- A drag preview shows what you are moving. Hold <kbd>Shift</kbd> to disable snapping.
- Canvas transfers keep Foundry's live token previews without adding a frame around the artwork. Movement still ignores walls and movement costs.
- While Transfer is held during a token drag, Foundry's movement ruler (highlight ring, path and distance labels) is hidden. Releasing Transfer immediately restores its normal visibility.
- Over sheets, the floating token preview captures Foundry's rendered artwork and decorations at the same scale and cursor anchor. Animated textures and effects pause in this floating capture and resume on returning to the canvas.

### Object tokens
Drop a consumable, container, equipment, loot, tool or weapon item onto the canvas to create an object token.

- The token is backed by an unlinked NPC "object" actor built from the item.
- <kbd>Alt</kbd>+drop hides it for the GM, and <kbd>Shift</kbd> disables snapping.
- Token size follows the object's size, and D&D 5e Token Size Sync scaling applies unless the token's scale is locked.
- Dropping an item on a vehicle token adds it as cargo. Dropping an object actor on a vehicle sheet does the same.

### Object properties
Item sheets gain an **Object Properties** section.

- Size, AC, HP, max HP, damage threshold and hit-point conditions.
- Damage resistances, immunities, vulnerabilities and modifications, condition immunities, and physical bypasses.
- Trait dialogs use the stock D&D 5e style, with an "All" checkbox and an "All Conditions" entry.
- Token configuration and **View Item Artwork** shortcuts.

### Linked item data
- A **Link Item Data** token option syncs item and object data between the world item and its linked tokens.
- Item-backed tokens must stay unlinked from world actors.
- With **Advanced Interface** installed, object tokens appear in the Items directory navigation.
