import {MODULE_ID, isTransferHeld, onTransferChange, registerTransferBinding} from "./controls.mjs";
import {createTransferPreview, installDragBridge} from "./transfer-drag.mjs";
import {transfer} from "./transfers.mjs";
import {addCargo, createObjectToken, registerObjectItems} from "./objects.mjs";

Hooks.once("init", () => {
	registerObjectItems();
	registerTransferBinding();
});
Hooks.once("ready", () => {
	const stop = installDragBridge();
	game.modules.get(MODULE_ID).api = {transfer, createObjectToken, addCargo, isTransferHeld, onTransferChange,
		createTransferPreview, stop};
});