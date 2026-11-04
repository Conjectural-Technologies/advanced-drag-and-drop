import {MODULE_ID, registerTransferBinding} from "./controls.mjs";
import {installDragBridge} from "./transfer-drag.mjs";
import {transfer} from "./transfers.mjs";
import {addCargo, createObjectToken, registerObjectItems} from "./objects.mjs";

Hooks.once("init", () => {
	registerObjectItems();
	registerTransferBinding();
});
Hooks.once("ready", () => {
	const stop = installDragBridge();
	game.modules.get(MODULE_ID).api = {transfer, createObjectToken, addCargo, stop};
});