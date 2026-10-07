import { EquipmentSlot, world, system, ItemStack } from "@minecraft/server";
import { ITEM_NAMES } from "../core/item_names.js";
import { ActionFormData, ModalFormData, CustomForm, ObservableString } from "@minecraft/server-ui";
import {
    buildRemoteReadOnlyNetworkItemIndexLoaded,
    resolveRemoteMutationIndexLoaded,
} from "../core/remote_network_item_index.js";
import { buildNetworkItemIndex } from "../core/network_item_index.js";
import { discoverRemoteStorageTopologyLoaded } from "../core/remote_storage_bridge.js";
import {
    NETWORK_CONTROLLER_BLOCK,
    NETWORK_CONTROLLER_ENTITY,
    NETWORK_TERMINAL_ENTITY,
    DIMENSION_IDS,
} from "../config/constants.js";
import { findMarkerAtBlock, ensureMarkerForBlock, dropEntityInventory } from "../core/marker.js";
import {
    detectCraftNodeNetwork,
    checkCraftNodeRecipeAvailability,
    readCraftNodeIndex,
    readCraftNodeRecord,
} from "./craft_node.js";

function ensureNetworkControllerMarker(block) {
    if (!block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return null;
    return ensureMarkerForBlock(block, NETWORK_CONTROLLER_ENTITY, null, NETWORK_CONTROLLER_BLOCK);
}

const NETWORK_INVENTORY_PAGE_SIZE = 10;
const NETWORK_ITEM_DETAIL_PAGE_SIZE = 8;
const controllerUiOpen = new Set();

function playerKey(player) {
    return player?.id ?? player?.name ?? "unknown";
}
function clampPage(page, pageCount) {
    if (!Number.isInteger(page) || page < 0) return 0;
    if (page >= pageCount) return Math.max(0, pageCount - 1);
    return page;
}
function itemLocalizationKey(typeId) {
    const text = String(typeId ?? "");
    if (!text) return "";
    try {
        return new ItemStack(text, 1).localizationKey || "";
    } catch {
        return "";
    }
}
function translatedItemName(typeId) {
    const key = itemLocalizationKey(typeId);
    return key ? { translate: key } : { text: String(typeId ?? "") };
}
function formatTypeId(typeId) {
    const text = String(typeId ?? "");
    const separator = text.indexOf(":");
    const rawName = separator >= 0 ? text.slice(separator + 1) : text;
    return (
        rawName
            .split("_")
            .filter(Boolean)
            .map((part) => (part.length > 0 ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
            .join(" ") || text
    );
}
function groupLocations(locations) {
    const groups = new Map();
    for (const location of locations ?? []) {
        const groupKey = `${location.scope ?? "local"}|${location.bridgeIndex ?? "local"}|${location.containerKey}`;
        let group = groups.get(groupKey);
        if (!group) {
            group = {
                containerKey: location.containerKey,
                scope: location.scope ?? "local",
                bridgeIndex: location.bridgeIndex ?? null,
                location: { ...location.location },
                containerTypeId: location.containerTypeId,
                amount: 0,
                stacks: 0,
            };
            groups.set(groupKey, group);
        }
        group.amount += location.amount;
        group.stacks += 1;
    }
    return [...groups.values()];
}
async function getControllerIndex(block) {
    if (!block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return null;
    return buildRemoteReadOnlyNetworkItemIndexLoaded(block);
}

function buildControllerLocalIndex(block) {
    return buildNetworkItemIndex(block);
}
function findControllerNetworkItem(block, typeId) {
    const id = typeof typeId === "string" ? typeId.trim() : "";
    const index = buildControllerLocalIndex(block);
    const e = index.byTypeId.get(id);
    return e
        ? {
              found: true,
              typeId: e.typeId,
              total: e.total,
              stacks: e.stacks,
              locations: e.locations,
          }
        : { found: false, typeId: id, total: 0, stacks: 0, locations: [] };
}
function insertControllerNetworkItem(block, itemStack) {
    return insertIntoSpecificNetworkIndex(buildControllerLocalIndex(block), itemStack);
}
function extractControllerNetworkItem(block, typeId, amount) {
    return extractFromNetworkIndex(buildControllerLocalIndex(block), typeId, amount);
}

function addStacksToPlayerInventory(player, stacks) {
    const inventory = player?.getComponent("minecraft:inventory")?.container;
    if (!inventory)
        return {
            delivered: 0,
            leftovers: stacks.slice(),
            errors: ["Player inventory unavailable"],
        };
    let delivered = 0;
    const leftovers = [];
    const errors = [];
    for (const stack of stacks) {
        try {
            const before = stack.amount;
            const playerStack = stack.clone();
            playerStack.nameTag = undefined;
            const leftover = inventory.addItem(playerStack);
            const remaining = leftover?.amount ?? 0;
            delivered += before - remaining;
            if (leftover) leftovers.push(leftover);
        } catch (error) {
            leftovers.push(stack);
            errors.push(String(error));
        }
    }
    return { delivered, leftovers, errors };
}
function rollbackControllerExtractedStacks(block, stacks) {
    let restored = 0;
    const leftovers = [];
    const errors = [];
    for (const stack of stacks) {
        const result = insertControllerNetworkItem(block, stack);
        restored += result.inserted;
        if (result.remainder) leftovers.push(result.remainder);
        for (const error of result.errors) errors.push(error.error);
    }
    return { restored, leftovers, errors };
}
function insertIntoSpecificNetworkIndex(index, itemStack) {
    const requested =
        Number.isInteger(itemStack?.amount) && itemStack.amount > 0 ? itemStack.amount : 0;
    if (!index?.storage?.containers || !itemStack || requested <= 0)
        return { requested, inserted: 0, remainder: itemStack, errors: [] };
    let remainder = itemStack;
    const errors = [];
    for (const target of index.storage.containers) {
        if (!remainder) break;
        const container = target?.container;
        if (!container) continue;
        try {
            if (!container.isValid) continue;
            const before = remainder?.amount ?? 0;
            const inputTypeId = remainder?.typeId ?? itemStack.typeId;
            remainder = container.addItem(remainder);
            const after = remainder?.amount ?? 0;
            const added = Math.max(0, before - after);
            if (added > 0) {
                const dimId =
                    target?.dimensionId ??
                    target?.block?.dimension?.id ??
                    target?.dimension?.id ??
                    "?";
                const loc = target?.location ?? target?.block?.location;
                const pos = loc ? `${loc.x},${loc.y},${loc.z}` : "?";
                (() => {})(
                    `[Craft Container Insert] type=${inputTypeId} added=${added} targetKey=${String(target?.key ?? "?")} dimension=${dimId} location=${pos}`,
                );
            }
        } catch (error) {
            errors.push(String(error));
        }
    }
    const remaining = remainder?.amount ?? 0;
    return { requested, inserted: requested - remaining, remainder, errors };
}

function extractFromNetworkIndex(index, typeId, amount) {
    const requested = Number.isInteger(amount) && amount > 0 ? amount : 0;
    const entry = index?.byTypeId?.get(typeId);
    if (!entry || requested <= 0)
        return { requested, extracted: 0, remaining: requested, stacks: [], errors: [] };
    const containers = new Map(
        (index.storage?.containers ?? []).map((target) => [target.key, target]),
    );
    const stacks = [],
        errors = [];
    let remaining = requested;
    for (const location of entry.locations) {
        if (remaining <= 0) break;
        const target = containers.get(location.containerKey),
            container = target?.container;
        if (!container) continue;
        try {
            if (!container.isValid) continue;
            const current = container.getItem(location.slot);
            if (!current || current.typeId !== typeId || current.amount <= 0) continue;
            const take = Math.min(remaining, current.amount);
            const out = current.clone();
            out.amount = take;
            if (take === current.amount) container.setItem(location.slot, undefined);
            else {
                const rest = current.clone();
                rest.amount = current.amount - take;
                container.setItem(location.slot, rest);
            }
            stacks.push(out);
            remaining -= take;
        } catch (error) {
            errors.push(String(error));
        }
    }
    return { requested, extracted: requested - remaining, remaining, stacks, errors };
}

async function rollbackRemoteExtract(block, bridgeIndex, stacks) {
    const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) return { restored: 0, leftovers: stacks.slice(), errors: [resolved.reason] };
    let restored = 0;
    const leftovers = [],
        errors = [];
    for (const stack of stacks) {
        const result = insertIntoSpecificNetworkIndex(resolved.index, stack);
        restored += result.inserted;
        if (result.remainder) leftovers.push(result.remainder);
        errors.push(...result.errors);
    }
    return { restored, leftovers, errors };
}

async function runControllerUiRemoteExtract(
    player,
    block,
    typeId,
    inventoryPage,
    amount,
    bridgeIndex,
) {
    const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) {
        player.sendMessage(`Remote extract aborted: ${resolved.reason}`);
        system.run(() => openNetworkItemDetail(player, block, typeId, inventoryPage));
        return;
    }
    const result = extractFromNetworkIndex(resolved.index, typeId, amount);
    const delivery = addStacksToPlayerInventory(player, result.stacks);
    const rollback =
        delivery.leftovers.length > 0
            ? await rollbackRemoteExtract(block, bridgeIndex, delivery.leftovers)
            : { restored: 0, leftovers: [], errors: [] };
    if (rollback.leftovers.length > 0) {
        // Never redirect failed remote rollback into local storage.
        for (const stack of rollback.leftovers) {
            try {
                block.dimension.spawnItem(stack, player.location);
            } catch (error) {
                rollback.errors.push(String(error));
            }
        }
    }
    showControllerExtractResult(
        player,
        block,
        typeId,
        inventoryPage,
        amount,
        result,
        delivery,
        rollback,
    );
}

async function openControllerRemoteExtractAmountForm(
    player,
    block,
    typeId,
    inventoryPage,
    bridgeIndex,
) {
    const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    const entry = resolved.ok ? resolved.index.byTypeId.get(typeId) : null;
    if (!entry || entry.total <= 0) {
        player.sendMessage(
            `Remote item is no longer available${resolved.ok ? "." : `: ${resolved.reason}`}`,
        );
        system.run(() => openNetworkItemDetail(player, block, typeId, inventoryPage));
        return;
    }
    const form = new ModalFormData()
        .title("Extract Remote Item")
        .textField(
            `${formatTypeId(typeId)}\nRemote Available: ${entry.total}\nAmount`,
            "1 - available",
            { defaultValue: String(Math.min(64, entry.total)) },
        )
        .submitButton("Extract");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || !Array.isArray(response.formValues)) return;
                const amount = Number(String(response.formValues[0] ?? "").trim());
                if (!Number.isSafeInteger(amount) || amount <= 0 || amount > entry.total) {
                    player.sendMessage(`Invalid extract amount. Enter 1-${entry.total}.`);
                    return;
                }
                system.run(() =>
                    runControllerUiRemoteExtract(
                        player,
                        block,
                        typeId,
                        inventoryPage,
                        amount,
                        bridgeIndex,
                    ),
                );
            })
            .catch((error) =>
                (() => {})(
                    `[Network Controller NC-6 9D] Remote Extract Amount UI failed: ${error}`,
                ),
            ),
    );
}

function showControllerExtractResult(
    player,
    block,
    typeId,
    inventoryPage,
    requested,
    result,
    delivery,
    rollback,
) {
    const form = new ActionFormData()
        .title("Extract Result")
        .body(
            `${formatTypeId(typeId)}\n\nRequested: ${requested}\nExtracted: ${result.extracted}\nAdded to Inventory: ${delivery.delivered}\nReturned to Network: ${rollback.restored}\nErrors: ${result.errors.length + delivery.errors.length + rollback.errors.length}`,
        )
        .button("Back to Item Detail")
        .button("Back to Inventory");
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    system.run(() => openNetworkItemDetail(player, block, typeId, inventoryPage));
                if (response.selection === 1)
                    system.run(() => openNetworkInventory(player, block, inventoryPage));
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-6 6C] Extract Result UI failed: ${error}`),
            );
    });
}
function runControllerUiExtract(player, block, typeId, inventoryPage, amount) {
    const result = extractControllerNetworkItem(block, typeId, amount);
    const delivery = addStacksToPlayerInventory(player, result.stacks);
    const rollback =
        delivery.leftovers.length > 0
            ? rollbackControllerExtractedStacks(block, delivery.leftovers)
            : { restored: 0, leftovers: [], errors: [] };
    if (rollback.leftovers.length > 0) {
        for (const stack of rollback.leftovers) {
            try {
                block.dimension.spawnItem(stack, {
                    x: block.location.x + 0.5,
                    y: block.location.y + 1,
                    z: block.location.z + 0.5,
                });
            } catch (error) {
                rollback.errors.push(String(error));
            }
        }
    }
    showControllerExtractResult(
        player,
        block,
        typeId,
        inventoryPage,
        amount,
        result,
        delivery,
        rollback,
    );
}
function openControllerExtractAmountForm(player, block, typeId, inventoryPage) {
    const item = findControllerNetworkItem(block, typeId);
    if (!item.found || item.total <= 0) {
        system.run(() => openNetworkItemDetail(player, block, typeId, inventoryPage));
        return;
    }
    const form = new ModalFormData()
        .title("Extract Item")
        .textField(`${formatTypeId(typeId)}\nAvailable: ${item.total}\nAmount`, "1 - available", {
            defaultValue: String(Math.min(64, item.total)),
        })
        .submitButton("Extract");
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || !Array.isArray(response.formValues)) return;
                const amount = Number(String(response.formValues[0] ?? "").trim());
                if (!Number.isSafeInteger(amount) || amount <= 0 || amount > item.total) {
                    player.sendMessage(`Invalid extract amount. Enter 1-${item.total}.`);
                    return;
                }
                system.run(() =>
                    runControllerUiExtract(player, block, typeId, inventoryPage, amount),
                );
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-6 6C] Extract Amount UI failed: ${error}`),
            );
    });
}

const NETWORK_DEPOSIT_PAGE_SIZE = 10;
function collectPlayerDepositEntries(player) {
    const inventory = player?.getComponent("minecraft:inventory")?.container;
    if (!inventory) return [];
    const byTypeId = new Map();
    for (let slot = 0; slot < inventory.size; slot++) {
        let item;
        try {
            item = inventory.getItem(slot);
        } catch {
            continue;
        }
        if (!item) continue;
        let entry = byTypeId.get(item.typeId);
        if (!entry) {
            entry = { typeId: item.typeId, total: 0, stacks: 0 };
            byTypeId.set(item.typeId, entry);
        }
        entry.total += item.amount;
        entry.stacks += 1;
    }
    return Array.from(byTypeId.values()).sort((a, b) => a.typeId.localeCompare(b.typeId));
}
function removePlayerInventoryItem(player, typeId, amount) {
    const inventory = player?.getComponent("minecraft:inventory")?.container;
    const requested = Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
    const stacks = [];
    const errors = [];
    if (!inventory || !typeId || requested <= 0)
        return { requested, removed: 0, remaining: requested, stacks, errors };
    let remaining = requested;
    for (let slot = 0; slot < inventory.size && remaining > 0; slot++) {
        try {
            const current = inventory.getItem(slot);
            if (!current || current.typeId !== typeId || current.amount <= 0) continue;
            const take = Math.min(remaining, current.amount);
            const taken = current.clone();
            taken.amount = take;
            if (take === current.amount) inventory.setItem(slot, undefined);
            else {
                const rest = current.clone();
                rest.amount = current.amount - take;
                inventory.setItem(slot, rest);
            }
            stacks.push(taken);
            remaining -= take;
        } catch (error) {
            errors.push(String(error));
        }
    }
    return { requested, removed: requested - remaining, remaining, stacks, errors };
}
function restoreStacksToPlayer(player, stacks) {
    const inventory = player?.getComponent("minecraft:inventory")?.container;
    let restored = 0;
    const leftovers = [];
    const errors = [];
    if (!inventory)
        return { restored, leftovers: stacks.slice(), errors: ["Player inventory unavailable"] };
    for (const stack of stacks) {
        try {
            const before = stack.amount;
            const leftover = inventory.addItem(stack);
            restored += before - (leftover?.amount ?? 0);
            if (leftover) leftovers.push(leftover);
        } catch (error) {
            leftovers.push(stack);
            errors.push(String(error));
        }
    }
    return { restored, leftovers, errors };
}
function showControllerRemoteDepositResult(
    player,
    block,
    typeId,
    requestedPage,
    requested,
    removed,
    inserted,
    returned,
    errors,
    bridgeIndex,
) {
    const form = new ActionFormData()
        .title("Remote Deposit Result")
        .body(
            `${formatTypeId(typeId)}\n\nRemote Bridge: ${bridgeIndex + 1}\nRequested: ${requested}\nRemoved from Inventory: ${removed}\nInserted to Remote Network: ${inserted}\nReturned to Inventory: ${returned}\nErrors: ${errors}`,
        )
        .button("Back to Deposit")
        .button("Network Inventory");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    system.run(() => openControllerDepositInventory(player, block, requestedPage));
                if (response.selection === 1) system.run(() => openNetworkInventory(player, block));
            })
            .catch((error) =>
                (() => {})(
                    `[Network Controller NC-6 9E] Remote Deposit Result UI failed: ${error}`,
                ),
            ),
    );
}

async function runControllerUiRemoteDeposit(
    player,
    block,
    typeId,
    requestedPage,
    amount,
    bridgeIndex,
) {
    // Resolve before removing anything from the player. This guarantees a broken
    // bridge cannot consume player inventory.
    let resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) {
        player.sendMessage(`Remote deposit aborted: ${resolved.reason}`);
        system.run(() => openControllerDepositInventory(player, block, requestedPage));
        return;
    }
    const removal = removePlayerInventoryItem(player, typeId, amount);
    let inserted = 0;
    let returned = 0;
    let errors = removal.errors.length;
    const returnStacks = [];
    for (const stack of removal.stacks) {
        // Re-resolve immediately before each mutation fragment. This avoids
        // writing through a stale bridge/index after a topology change.
        resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
        if (!resolved.ok) {
            returnStacks.push(stack);
            errors++;
            continue;
        }
        const result = insertIntoSpecificNetworkIndex(resolved.index, stack);
        inserted += result.inserted;
        errors += result.errors.length;
        if (result.remainder) returnStacks.push(result.remainder);
    }
    const restore = restoreStacksToPlayer(player, returnStacks);
    returned += restore.restored;
    errors += restore.errors.length;
    if (restore.leftovers.length > 0) {
        // The remote network is never substituted with the local network.
        // If player rollback itself has no room, drop at the player to prevent loss.
        for (const stack of restore.leftovers) {
            try {
                block.dimension.spawnItem(stack, player.location);
            } catch (error) {
                errors++;
                (() => {})(
                    `[Network Controller NC-6 9E] Remote Deposit fallback drop failed: ${error}`,
                );
            }
        }
    }
    showControllerRemoteDepositResult(
        player,
        block,
        typeId,
        requestedPage,
        amount,
        removal.removed,
        inserted,
        returned,
        errors,
        bridgeIndex,
    );
}

async function openControllerRemoteDepositAmountForm(
    player,
    block,
    typeId,
    requestedPage,
    bridgeIndex,
) {
    const entry = collectPlayerDepositEntries(player).find((item) => item.typeId === typeId);
    if (!entry || entry.total <= 0) {
        player.sendMessage("That item is no longer in your inventory.");
        system.run(() => openControllerDepositInventory(player, block, requestedPage));
        return;
    }
    const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) {
        player.sendMessage(`Remote deposit unavailable: ${resolved.reason}`);
        system.run(() => openControllerDepositInventory(player, block, requestedPage));
        return;
    }
    const form = new ModalFormData()
        .title("Deposit Remote Item")
        .textField(
            `${formatTypeId(typeId)}\nRemote Bridge: ${bridgeIndex + 1}\nAvailable: ${entry.total}\nAmount`,
            "1 - available",
            { defaultValue: String(Math.min(64, entry.total)) },
        )
        .submitButton("Deposit");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || !Array.isArray(response.formValues)) return;
                const amount = Number(String(response.formValues[0] ?? "").trim());
                if (!Number.isSafeInteger(amount) || amount <= 0 || amount > entry.total) {
                    player.sendMessage(`Invalid deposit amount. Enter 1-${entry.total}.`);
                    return;
                }
                system.run(() =>
                    runControllerUiRemoteDeposit(
                        player,
                        block,
                        typeId,
                        requestedPage,
                        amount,
                        bridgeIndex,
                    ),
                );
            })
            .catch((error) =>
                (() => {})(
                    `[Network Controller NC-6 9E] Remote Deposit Amount UI failed: ${error}`,
                ),
            ),
    );
}

async function openControllerDepositTargetForm(player, block, typeId, requestedPage) {
    const topology = await discoverRemoteStorageTopologyLoaded(block);
    const availableRemoteBridges = [];
    for (let bridgeIndex = 0; bridgeIndex < (topology?.bridges?.length ?? 0); bridgeIndex++) {
        const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
        if (resolved.ok) availableRemoteBridges.push(bridgeIndex);
    }
    if (availableRemoteBridges.length === 0) {
        system.run(() => openControllerDepositAmountForm(player, block, typeId, requestedPage));
        return;
    }
    const form = new ActionFormData()
        .title("Deposit Target")
        .body(`${formatTypeId(typeId)}\n\nSelect destination network.`)
        .button("Local Network");
    const actions = [{ type: "local" }];
    for (const bridgeIndex of availableRemoteBridges) {
        const bridge = topology.bridges[bridgeIndex];
        form.button(
            `Remote Bridge ${bridgeIndex + 1}\n${bridge?.result?.channel || "(no channel)"}`,
        );
        actions.push({ type: "remote", bridgeIndex });
    }
    form.button("< Back");
    actions.push({ type: "back" });
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action) return;
                if (action.type === "local")
                    system.run(() =>
                        openControllerDepositAmountForm(player, block, typeId, requestedPage),
                    );
                if (action.type === "remote")
                    system.run(() =>
                        openControllerRemoteDepositAmountForm(
                            player,
                            block,
                            typeId,
                            requestedPage,
                            action.bridgeIndex,
                        ),
                    );
                if (action.type === "back")
                    system.run(() => openControllerDepositInventory(player, block, requestedPage));
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-6 9E] Deposit Target UI failed: ${error}`),
            ),
    );
}

function showControllerDepositResult(
    player,
    block,
    typeId,
    requestedPage,
    requested,
    removed,
    inserted,
    returned,
    errors,
) {
    const form = new ActionFormData()
        .title("Deposit Result")
        .body(
            `${formatTypeId(typeId)}\n\nRequested: ${requested}\nRemoved from Inventory: ${removed}\nInserted to Network: ${inserted}\nReturned to Inventory: ${returned}\nErrors: ${errors}`,
        )
        .button("Back to Deposit")
        .button("Network Inventory");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    system.run(() => openControllerDepositInventory(player, block, requestedPage));
                if (response.selection === 1) system.run(() => openNetworkInventory(player, block));
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-6 7B] Deposit Result UI failed: ${error}`),
            ),
    );
}
function runControllerUiDeposit(player, block, typeId, requestedPage, amount) {
    const removal = removePlayerInventoryItem(player, typeId, amount);
    let inserted = 0;
    let returned = 0;
    let errors = removal.errors.length;
    const returnStacks = [];
    for (const stack of removal.stacks) {
        const result = insertControllerNetworkItem(block, stack);
        inserted += result.inserted;
        errors += result.errors.length;
        if (result.remainder) returnStacks.push(result.remainder);
    }
    const restore = restoreStacksToPlayer(player, returnStacks);
    returned += restore.restored;
    errors += restore.errors.length;
    if (restore.leftovers.length > 0) {
        for (const stack of restore.leftovers) {
            try {
                block.dimension.spawnItem(stack, player.location);
            } catch (error) {
                errors++;
                (() => {})(`[Network Controller NC-6 7B] Deposit fallback drop failed: ${error}`);
            }
        }
    }
    showControllerDepositResult(
        player,
        block,
        typeId,
        requestedPage,
        amount,
        removal.removed,
        inserted,
        returned,
        errors,
    );
}
function openControllerDepositAmountForm(player, block, typeId, requestedPage = 0) {
    const entry = collectPlayerDepositEntries(player).find((item) => item.typeId === typeId);
    if (!entry || entry.total <= 0) {
        player.sendMessage("That item is no longer in your inventory.");
        system.run(() => openControllerDepositInventory(player, block, requestedPage));
        return;
    }
    const form = new ModalFormData()
        .title("Deposit Item")
        .textField(`${formatTypeId(typeId)}\nAvailable: ${entry.total}\nAmount`, "1 - available", {
            defaultValue: String(Math.min(64, entry.total)),
        })
        .submitButton("Deposit");
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || !Array.isArray(response.formValues)) return;
                const amount = Number(String(response.formValues[0] ?? "").trim());
                if (!Number.isSafeInteger(amount) || amount <= 0 || amount > entry.total) {
                    player.sendMessage(`Invalid deposit amount. Enter 1-${entry.total}.`);
                    return;
                }
                system.run(() =>
                    runControllerUiDeposit(player, block, typeId, requestedPage, amount),
                );
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-6 7B] Deposit Amount UI failed: ${error}`),
            );
    });
}
function openControllerDepositInventory(player, block, requestedPage = 0) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const entries = collectPlayerDepositEntries(player);
    const pageCount = Math.max(1, Math.ceil(entries.length / NETWORK_DEPOSIT_PAGE_SIZE));
    const page = clampPage(requestedPage, pageCount);
    const start = page * NETWORK_DEPOSIT_PAGE_SIZE;
    const pageEntries = entries.slice(start, start + NETWORK_DEPOSIT_PAGE_SIZE);
    const form = new ActionFormData()
        .title("Deposit to Network")
        .body(`Inventory Item Types: ${entries.length}\nPage: ${page + 1}/${pageCount}`);
    const actions = [];
    if (pageEntries.length === 0) {
        form.button("(Inventory Empty)");
        actions.push({ type: "noop" });
    } else {
        for (const entry of pageEntries) {
            form.button(
                `${formatTypeId(entry.typeId)}\n${entry.total} items / ${entry.stacks} stacks`,
            );
            actions.push({ type: "item", typeId: entry.typeId, page });
        }
    }
    if (page > 0) {
        form.button("< Previous");
        actions.push({ type: "page", page: page - 1 });
    }
    if (page + 1 < pageCount) {
        form.button("Next >");
        actions.push({ type: "page", page: page + 1 });
    }
    form.button("< Back to Network Controller");
    actions.push({ type: "back" });
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action || action.type === "noop") return;
                if (action.type === "item") {
                    system.run(() =>
                        openControllerDepositTargetForm(player, block, action.typeId, action.page),
                    );
                    return;
                }
                if (action.type === "page") {
                    system.run(() => openControllerDepositInventory(player, block, action.page));
                    return;
                }
                if (action.type === "back") {
                    system.run(() => openNetworkControllerMenu(player, block));
                }
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-6 7A] Deposit Inventory UI failed: ${error}`),
            );
    });
}

function openNetworkLocationDetail(player, block, typeId, inventoryPage, detailPage, location) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK || !location) return;
    const pos = location.location ?? {};
    const storagePos = location.storageNodeLocation ?? {};
    const scopeLabel = location.scope === "remote" ? "REMOTE" : "LOCAL";
    const bridgeText =
        location.scope === "remote" && Number.isInteger(location.bridgeIndex)
            ? `\nRemote Bridge: ${location.bridgeIndex + 1}`
            : "";
    const storageText =
        Number.isFinite(storagePos.x) &&
        Number.isFinite(storagePos.y) &&
        Number.isFinite(storagePos.z)
            ? `\nStorage Node: ${storagePos.x}, ${storagePos.y}, ${storagePos.z}`
            : "";
    const form = new ActionFormData()
        .title("Container Location")
        .body(
            `${formatTypeId(typeId)}\n\nScope: ${scopeLabel}${bridgeText}\nContainer: ${location.containerTypeId ?? "unknown"}\nDimension: ${location.dimensionId ?? "unknown"}\nPosition: ${pos.x}, ${pos.y}, ${pos.z}${storageText}\nItems: ${location.amount}\nStacks: ${location.stacks}`,
        )
        .button("Back to Item Detail")
        .button("Back to Inventory");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    openNetworkItemDetail(player, block, typeId, inventoryPage, detailPage);
                if (response.selection === 1) openNetworkInventory(player, block, inventoryPage);
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-7F] Location Detail UI failed: ${error}`),
            ),
    );
}

async function openNetworkItemDetail(
    player,
    block,
    typeId,
    inventoryPage = 0,
    requestedDetailPage = 0,
) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const index = await getControllerIndex(block);
    const item = index?.byTypeId?.get(typeof typeId === "string" ? typeId.trim() : "");
    if (!item) {
        const form = new ActionFormData()
            .title({ translate: "vfh.ui.network_controller.item_detail" })
            .body(`${formatTypeId(typeId)}\n\n${"This item is no longer present in the network."}`)
            .button({ translate: "vfh.ui.network_controller.back_inventory" });
        system.run(() =>
            form
                .show(player)
                .then((response) => {
                    if (!response.canceled && response.selection === 0)
                        openNetworkInventory(player, block, inventoryPage);
                })
                .catch((error) =>
                    (() => {})(`[Network Controller NC-4] Item Detail UI failed: ${error}`),
                ),
        );
        return;
    }
    const locations = groupLocations(item.locations);
    const pageCount = Math.max(1, Math.ceil(locations.length / NETWORK_ITEM_DETAIL_PAGE_SIZE));
    const page = clampPage(requestedDetailPage, pageCount);
    const pageLocations = locations.slice(
        page * NETWORK_ITEM_DETAIL_PAGE_SIZE,
        (page + 1) * NETWORK_ITEM_DETAIL_PAGE_SIZE,
    );
    const form = new ActionFormData()
        .title({ translate: "vfh.ui.network_controller.item_detail" })
        .body(
            `${formatTypeId(item.typeId)}\n\nTotal: ${item.total}\nStacks: ${item.stacks}\nLocations: ${locations.length}\nPage: ${page + 1}/${pageCount}`,
        );
    const actions = [];
    for (const location of pageLocations) {
        const pos = location.location;
        const scopeLabel = location.scope === "remote" ? "[REMOTE]" : "[LOCAL]";
        form.button(
            `${scopeLabel} ${location.containerTypeId}\n${pos.x}, ${pos.y}, ${pos.z} | ${location.amount} items / ${location.stacks} stacks`,
        );
        actions.push({ type: "location", location, detailPage: page });
    }
    if (page > 0) {
        form.button({ translate: "vfh.ui.network_controller.previous" });
        actions.push({ type: "page", page: page - 1 });
    }
    if (page + 1 < pageCount) {
        form.button({ translate: "vfh.ui.network_controller.next" });
        actions.push({ type: "page", page: page + 1 });
    }
    const hasLocalLocation = locations.some((location) => location.scope === "local");
    const remoteBridgeIndexes = [
        ...new Set(
            item.locations
                .filter(
                    (location) =>
                        location.scope === "remote" && Number.isInteger(location.bridgeIndex),
                )
                .map((location) => location.bridgeIndex),
        ),
    ];
    if (hasLocalLocation) {
        form.button("Extract Item (Local)");
        actions.push({ type: "extract" });
    }
    for (const bridgeIndex of remoteBridgeIndexes) {
        form.button(`Extract Item (Remote Bridge ${bridgeIndex + 1})`);
        actions.push({ type: "remoteExtract", bridgeIndex });
    }
    form.button({ translate: "vfh.ui.network_controller.back_inventory" });
    actions.push({ type: "back" });
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action) return;
                if (action.type === "location")
                    openNetworkLocationDetail(
                        player,
                        block,
                        typeId,
                        inventoryPage,
                        action.detailPage,
                        action.location,
                    );
                if (action.type === "page")
                    openNetworkItemDetail(player, block, typeId, inventoryPage, action.page);
                if (action.type === "extract")
                    openControllerExtractAmountForm(player, block, typeId, inventoryPage);
                if (action.type === "remoteExtract")
                    openControllerRemoteExtractAmountForm(
                        player,
                        block,
                        typeId,
                        inventoryPage,
                        action.bridgeIndex,
                    );
                if (action.type === "back") openNetworkInventory(player, block, inventoryPage);
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-4] Item Detail UI failed: ${error}`),
            ),
    );
}
async function openNetworkInventory(player, block, requestedPage = 0) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const index = await getControllerIndex(block);
    if (!index) return;
    const pageCount = Math.max(1, Math.ceil(index.entries.length / NETWORK_INVENTORY_PAGE_SIZE));
    const page = clampPage(requestedPage, pageCount);
    const entries = index.entries.slice(
        page * NETWORK_INVENTORY_PAGE_SIZE,
        (page + 1) * NETWORK_INVENTORY_PAGE_SIZE,
    );
    const form = new ActionFormData()
        .title({ translate: "vfh.ui.network_controller.inventory" })
        .body(
            `Unique Items: ${index.uniqueItems}\nTotal Items: ${index.totalItems}\nTotal Stacks: ${index.totalStacks}\nPage: ${page + 1}/${pageCount}`,
        );
    const actions = [];
    if (entries.length === 0) {
        form.button({ translate: "vfh.ui.network_controller.empty" });
        actions.push({ type: "noop" });
    } else {
        for (const entry of entries) {
            form.button(
                `${formatTypeId(entry.typeId)}\n${entry.total} items / ${entry.stacks} stacks`,
            );
            actions.push({ type: "detail", typeId: entry.typeId });
        }
    }
    if (page > 0) {
        form.button({ translate: "vfh.ui.network_controller.previous" });
        actions.push({ type: "page", page: page - 1 });
    }
    if (page + 1 < pageCount) {
        form.button({ translate: "vfh.ui.network_controller.next" });
        actions.push({ type: "page", page: page + 1 });
    }
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action || action.type === "noop") return;
                if (action.type === "detail")
                    openNetworkItemDetail(player, block, action.typeId, page);
                if (action.type === "page") openNetworkInventory(player, block, action.page);
            })
            .catch((error) =>
                (() => {})(`[Network Controller NC-4] Network Inventory UI failed: ${error}`),
            )
            .finally(() => controllerUiOpen.delete(playerKey(player))),
    );
}

// UI-1B DDUI prototype: read-only Network Storage Viewer.
// CustomForm is currently a pre-release DDUI API. This prototype intentionally
// performs no network mutation and keeps the existing ActionForm UI available.
function buildUi1bSummary(index) {
    if (!index) return "Network index unavailable";
    return `Unique Items: ${index.uniqueItems}\nTotal Items: ${index.totalItems}\nTotal Stacks: ${index.totalStacks}`;
}

async function openNetworkStorageViewerDdUi(player, block) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const index = await getControllerIndex(block);
    if (!index) return;

    const summary = new ObservableString(buildUi1bSummary(index));
    const form = new CustomForm(player, "Network Storage Viewer")
        .closeButton()
        .header("Network Storage")
        .label(summary)
        .divider();

    if (index.entries.length === 0) {
        form.label("(Empty)");
    } else {
        // @minecraft/server-ui 2.7.0: multiButtonRow is not available in the
        // runtime used by this pack. Use the verified CustomForm.button API.
        for (const entry of index.entries) {
            form.button(
                `${formatTypeId(entry.typeId)}\n${entry.total} items / ${entry.stacks} stacks`,
                () => {},
                {
                    disabled: true,
                    tooltip: `${formatTypeId(entry.typeId)} | ${entry.total} items | ${entry.stacks} stacks`,
                },
            );
        }
    }

    form.spacer()
        .divider()
        .header("Player Inventory")
        .label(
            "UI-1B prototype: network viewer is read-only. Player inventory slot rendering is not exposed by the verified DDUI controls used here.",
        );

    try {
        await form.show();
    } catch (error) {
        (() => {})(`[Network Controller UI-1B DDUI] Viewer failed: ${error}`);
    }
}

const VFH_CRAFT_RECIPE_SLOTS = [60, 61, 62, 63, 64, 65, 66, 67, 68],
    VFH_CRAFT_OUTPUT_SLOT = 69,
    VFH_CRAFT_CLEAR_SLOT = 70;
function vfhIsCraftProtectedSlot(slot) {
    return slot >= VFH_CRAFT_RECIPE_SLOTS[0] && slot <= VFH_CRAFT_CLEAR_SLOT;
}
function vfhCraftKey(inv) {
    return VFH_CRAFT_RECIPE_SLOTS.map((i) => {
        const it = inv.getItem(i);
        return it ? `${it.typeId}#${it.amount}` : "empty#0";
    }).join("|");
}
function vfhCraftConfig(d) {
    if (d === "minecraft:nether") return { y: 0 };
    if (d === "minecraft:the_end") return { y: 0 };
    return { y: -64 };
}
function vfhCraftButton(name) {
    const x = new ItemStack("vfh:terminal_button_ui", 1);
    x.nameTag = name;
    return x;
}
function vfhCraftTrace(stage, detail = "") {
    (() => {})(`[VFH Craft] ${stage}${detail ? `: ${detail}` : ""}`);
}
function vfhCraftWorkspace(dim, p) {
    const ps = [p, { x: p.x, y: p.y + 1, z: p.z }, { x: p.x + 1, y: p.y, z: p.z }];
    return ps.map((q) => ({ q, permutation: dim.getBlock(q)?.permutation }));
}
function vfhCleanupCrafter(dim, saved) {
    for (const x of [...saved].reverse()) {
        try {
            if (x.permutation) dim.getBlock(x.q)?.setPermutation(x.permutation);
        } catch (err) {
            vfhCraftTrace("restore failed", `${x.q.x},${x.q.y},${x.q.z} ${err}`);
        }
    }
}
function vfhNearbyItemIds(dim, p) {
    return new Set(
        dim
            .getEntities({
                type: "minecraft:item",
                location: { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 },
                maxDistance: 4,
            })
            .map((e) => e.id),
    );
}
function vfhNewCraftDrops(dim, p, before) {
    return dim
        .getEntities({
            type: "minecraft:item",
            location: { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 },
            maxDistance: 4,
        })
        .filter((e) => !before.has(e.id));
}
const vfhCraftMachines = new Map();
function vfhCraftMachineKey(terminal) {
    return ui1cKey(terminal);
}
function vfhResetCraftProperties(terminal) {
    terminal.setDynamicProperty("vfh:craftPreview", false);
    terminal.setDynamicProperty("vfh:pendingConsume", undefined);
    terminal.setDynamicProperty("vfh:armedConsume", undefined);
    terminal.setDynamicProperty("vfh:outputRecipeKey", undefined);
}
function vfhStopCraftMachine(terminal, clearOutput = false) {
    const k = vfhCraftMachineKey(terminal),
        m = vfhCraftMachines.get(k);
    if (m) {
        try {
            vfhCleanupCrafter(m.dim, m.saved);
        } catch {}
        vfhCraftMachines.delete(k);
    }
    // Slot 69 is finalized craft output. Never erase it from lifecycle cleanup.
}
const VFH_CRAFT_INPUT_DEBOUNCE_TICKS = 10;
const VFH_CRAFT_PLACE_SETTLE_TICKS = 4;
const VFH_CRAFT_LOAD_SETTLE_TICKS = 4;
const VFH_CRAFT_PULSE_TICKS = 2;
const VFH_CRAFT_POST_PULSE_SETTLE_TICKS = 4;
function vfhRefreshCraftPreview(block, terminal) {
    const inv = terminal?.getComponent("inventory")?.container;
    if (!inv) return;
    const key = vfhCraftKey(inv),
        old = terminal.getDynamicProperty("vfh:craftKey"),
        ss = ui1cGetSession(terminal);
    if (old !== key) {
        vfhStopCraftMachine(terminal, false);
        if (ss) {
            ss.craftOutput = undefined;
            ss.craftConsume = [];
            ss.craftPreviewKey = undefined;
            ss.craftDebounceKey = key;
            ss.craftDebounceTick = system.currentTick;
        }
        terminal.setDynamicProperty("vfh:craftKey", key);
        vfhResetCraftProperties(terminal);
        return;
    }
    const hasRecipe = VFH_CRAFT_RECIPE_SLOTS.some((i) => inv.getItem(i));
    if (!hasRecipe) {
        vfhStopCraftMachine(terminal, false);
        if (ss) {
            ss.craftDebounceKey = undefined;
            ss.craftDebounceTick = undefined;
        }
        return;
    }
    if (terminal.getDynamicProperty("vfh:pendingConsume") && inv.getItem(VFH_CRAFT_OUTPUT_SLOT))
        return;
    if (ss) {
        if (ss.craftDebounceKey !== key) {
            ss.craftDebounceKey = key;
            ss.craftDebounceTick = system.currentTick;
            return;
        }
        if (
            system.currentTick - (ss.craftDebounceTick ?? system.currentTick) <
            VFH_CRAFT_INPUT_DEBOUNCE_TICKS
        )
            return;
    }
    const mk = vfhCraftMachineKey(terminal);
    if (vfhCraftMachines.has(mk)) return;
    const cfg = vfhCraftConfig(block.dimension.id),
        p = { x: Math.floor(block.x), y: cfg.y, z: Math.floor(block.z) },
        dim = block.dimension;
    vfhCraftMachines.set(mk, {
        dim,
        p,
        saved: vfhCraftWorkspace(dim, p),
        before: vfhNearbyItemIds(dim, p),
        phase: "place",
        phaseTick: system.currentTick,
        key,
        loaded: [],
    });
}
function vfhTickCraftMachine(block, terminal) {
    const inv = terminal?.getComponent("inventory")?.container;
    if (!inv) return false;
    const mk = vfhCraftMachineKey(terminal),
        m = vfhCraftMachines.get(mk);
    if (!m) return false;
    try {
        const key = vfhCraftKey(inv);
        if (key !== m.key) {
            vfhStopCraftMachine(terminal, false);
            terminal.setDynamicProperty("vfh:craftKey", undefined);
            return true;
        }
        if (m.phase === "place") {
            m.dim.runCommand(
                `setblock ${m.p.x} ${m.p.y} ${m.p.z} crafter ["orientation"="up_east"]`,
            );
            m.dim.runCommand(`setblock ${m.p.x} ${m.p.y + 1} ${m.p.z} air`);
            m.dim.runCommand(`setblock ${m.p.x + 1} ${m.p.y} ${m.p.z} air`);
            m.phase = "load";
            m.phaseTick = system.currentTick;
            return true;
        }
        if (m.phase === "load") {
            if (system.currentTick - m.phaseTick < VFH_CRAFT_PLACE_SETTLE_TICKS) return false;
            for (let i = 0; i < 9; i++) {
                const it = inv.getItem(VFH_CRAFT_RECIPE_SLOTS[i]);
                m.dim.runCommand(
                    it
                        ? `replaceitem block ${m.p.x} ${m.p.y} ${m.p.z} slot.container ${i} ${it.typeId} 1`
                        : `replaceitem block ${m.p.x} ${m.p.y} ${m.p.z} slot.container ${i} air`,
                );
            }
            m.loaded = VFH_CRAFT_RECIPE_SLOTS.map((slot) => inv.getItem(slot)?.clone());
            m.phase = "pulseOn";
            m.phaseTick = system.currentTick;
            return true;
        }
        if (m.phase === "pulseOn") {
            if (system.currentTick - m.phaseTick < VFH_CRAFT_LOAD_SETTLE_TICKS) return false;
            m.dim.runCommand(`setblock ${m.p.x + 1} ${m.p.y} ${m.p.z} redstone_block`);
            m.phase = "pulseOff";
            m.phaseTick = system.currentTick;
            return true;
        }
        if (m.phase === "pulseOff") {
            if (system.currentTick - m.phaseTick < VFH_CRAFT_PULSE_TICKS) return false;
            m.dim.runCommand(`setblock ${m.p.x + 1} ${m.p.y} ${m.p.z} air`);
            m.phase = "postPulse";
            m.phaseTick = system.currentTick;
            return true;
        }
        if (m.phase === "postPulse") {
            if (system.currentTick - m.phaseTick < VFH_CRAFT_POST_PULSE_SETTLE_TICKS) return false;
            m.phase = "waitDrop";
            m.phaseTick = system.currentTick;
            return true;
        }
        if (m.phase === "waitDrop") {
            const drops = vfhNewCraftDrops(m.dim, m.p, m.before),
                c = drops
                    .map((e) => ({ e, stack: e.getComponent("minecraft:item")?.itemStack }))
                    .filter((x) => x.stack);
            if (!c.length) {
                if (system.currentTick - m.phaseTick < 12) return false;
                vfhStopCraftMachine(terminal, false);
                return true;
            }
            if (c.length !== 1) {
                for (const x of c) {
                    try {
                        x.e.remove();
                    } catch {}
                }
                throw new Error(`ambiguous crafter output: ${c.length}`);
            }
            const consume = m.loaded.map((it) => (it ? 1 : 0)),
                out = c[0].stack.clone(),
                ss = ui1cGetSession(terminal);
            let craftCount = Infinity;
            for (let i = 0; i < 9; i++) {
                const n = consume[i] ?? 0;
                if (!n) continue;
                const it = inv.getItem(VFH_CRAFT_RECIPE_SLOTS[i]);
                if (!it) {
                    craftCount = 0;
                    break;
                }
                craftCount = Math.min(craftCount, Math.floor(it.amount / n));
            }
            if (!Number.isFinite(craftCount) || craftCount < 1) {
                try {
                    c[0].e.remove();
                } catch {}
                vfhStopCraftMachine(terminal, false);
                return true;
            }
            const perCraft = Math.max(1, out.amount ?? 1),
                existingOutput = inv.getItem(VFH_CRAFT_OUTPUT_SLOT),
                maxAmount = out.maxAmount ?? 64;
            if (existingOutput && existingOutput.typeId !== out.typeId) {
                try {
                    c[0].e.remove();
                } catch {}
                vfhStopCraftMachine(terminal, false);
                return true;
            }
            const occupied = existingOutput?.amount ?? 0,
                free = Math.max(0, maxAmount - occupied),
                outputCrafts = Math.floor(free / perCraft);
            if (outputCrafts < 1) {
                try {
                    c[0].e.remove();
                } catch {}
                vfhStopCraftMachine(terminal, false);
                return true;
            }
            craftCount = Math.min(craftCount, outputCrafts);
            if (craftCount < 1) {
                try {
                    c[0].e.remove();
                } catch {}
                vfhStopCraftMachine(terminal, false);
                return true;
            }
            for (let i = 0; i < 9; i++) {
                const n = consume[i] ?? 0;
                if (!n) continue;
                const slot = VFH_CRAFT_RECIPE_SLOTS[i],
                    it = inv.getItem(slot),
                    used = n * craftCount;
                if (!it || it.amount < used) {
                    try {
                        c[0].e.remove();
                    } catch {}
                    vfhStopCraftMachine(terminal, false);
                    return true;
                }
                const left = it.amount - used;
                if (left <= 0) inv.setItem(slot, undefined);
                else {
                    const rest = it.clone();
                    rest.amount = left;
                    inv.setItem(slot, rest);
                }
            }
            const result = out.clone();
            result.amount = perCraft * craftCount + occupied;
            inv.setItem(VFH_CRAFT_OUTPUT_SLOT, result);
            terminal.setDynamicProperty("vfh:craftPreview", true);
            terminal.setDynamicProperty("vfh:pendingConsume", true);
            terminal.setDynamicProperty("vfh:armedConsume", undefined);
            terminal.setDynamicProperty("vfh:outputRecipeKey", key);
            if (ss) {
                ss.craftOutput = result.clone();
                ss.craftConsume = [];
                ss.craftPreviewKey = key;
            }
            try {
                c[0].e.remove();
            } catch {}
            vfhStopCraftMachine(terminal, false);
            return true;
        }
    } catch (err) {
        vfhCraftTrace("tick preview failed", String(err));
        vfhStopCraftMachine(terminal, false);
        return true;
    }
    return false;
}
function vfhInitCraftControls(inv) {
    if (!inv.getItem(VFH_CRAFT_CLEAR_SLOT))
        inv.setItem(VFH_CRAFT_CLEAR_SLOT, vfhCraftButton("§rClear Recipe"));
}

const UI1C_VIEW_SLOT_COUNT = 54,
    UI1C_VIEW_SLOT_OFFSET = 1;
const UI1D_PREV = 55,
    UI1D_NEXT = 56,
    UI1D_INFO = 57,
    UI1D_SEARCH = 58,
    UI1D_CLEAR = 59;
const ui1cSessions = new Map(),
    remoteUi1cSessions = new Map(),
    ui1dLiveLoops = new Map(),
    ui1dSearchTransitions = new Set(),
    ui1dPendingSearch = new Map(),
    ui1dControlLocks = new Set();
function ui1cKey(e) {
    return e?.id ?? "";
}
function ui1cGetSession(e, p) {
    if (e?.typeId === "entity:remote_crafting_terminal") {
        let owner;
        try {
            owner = e.getDynamicProperty("vfh:remote_owner");
        } catch {}
        return remoteUi1cSessions.get(p?.id || owner);
    }
    return ui1cSessions.get(ui1cKey(e));
}
function findNetworkTerminal(b) {
    return (
        b.dimension.getEntities({
            type: NETWORK_TERMINAL_ENTITY,
            location: b.center(),
            maxDistance: 0.8,
        })[0] ?? null
    );
}
function ensureNetworkTerminal(b) {
    let e = findNetworkTerminal(b);
    if (!e) e = b.dimension.spawnEntity(NETWORK_TERMINAL_ENTITY, b.center());
    e.nameTag = "Crafting Terminal";
    try {
        e.setDynamicProperty(
            "vfh:local_terminal_home",
            JSON.stringify({ d: b.dimension.id, x: b.x, y: b.y, z: b.z }),
        );
    } catch {}
    return e;
}
function ensureLocalUi1cSession(e, b, player = null) {
    const key = ui1cKey(e),
        existing = ui1cSessions.get(key),
        loc = { x: b.x, y: b.y, z: b.z };
    if (existing) {
        existing.block = loc;
        existing.playerId = player?.id ?? existing.playerId ?? null;
        existing.controllerDimensionId = b.dimension.id;
        existing.remote = false;
        return existing;
    }
    const created = {
        block: loc,
        playerId: player?.id ?? null,
        snapshot: [],
        page: 0,
        pageCount: 1,
        query: "",
        remote: false,
        controllerDimensionId: b.dimension.id,
    };
    ui1cSessions.set(key, created);
    return created;
}
function ui1dFaceTerminalLocation(b, face) {
    const c = b.center(),
        d = 0.42;
    switch (String(face)) {
        case "North":
            return { x: c.x, y: c.y, z: c.z - d };
        case "South":
            return { x: c.x, y: c.y, z: c.z + d };
        case "East":
            return { x: c.x + d, y: c.y, z: c.z };
        case "West":
            return { x: c.x - d, y: c.y, z: c.z };
        case "Down":
            return { x: c.x, y: c.y - d, z: c.z };
        default:
            return { x: c.x, y: c.y + d, z: c.z };
    }
}
const UI1D_CONTROL_ITEM = "vfh:terminal_button_ui";
function makeCtl(n) {
    const x = new ItemStack(UI1D_CONTROL_ITEM);
    x.nameTag = n;
    return x;
}
function purgeUi1dControlItems(player) {
    const inv = player?.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    for (let i = 0; i < inv.size; i++) {
        const item = inv.getItem(i);
        if (item?.typeId === UI1D_CONTROL_ITEM) inv.setItem(i, undefined);
    }
}
function countPlayerItem(player, typeId) {
    const inv = player?.getComponent("minecraft:inventory")?.container;
    if (!inv) return 0;
    let n = 0;
    for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (it?.typeId === typeId) n += it.amount;
    }
    return n;
}
function removePlayerItemAboveBaseline(player, typeId, baseline, maxRemove) {
    const inv = player?.getComponent("minecraft:inventory")?.container;
    if (!inv || maxRemove <= 0) return 0;
    let extra = Math.max(0, countPlayerItem(player, typeId) - Math.max(0, baseline)),
        need = Math.min(extra, maxRemove),
        removed = 0;
    for (let i = inv.size - 1; i >= 0 && removed < need; i--) {
        const it = inv.getItem(i);
        if (!it || it.typeId !== typeId) continue;
        const n = Math.min(need - removed, it.amount);
        if (n === it.amount) inv.setItem(i, undefined);
        else {
            const cp = it.clone();
            cp.amount -= n;
            inv.setItem(i, cp);
        }
        removed += n;
    }
    return removed;
}
function purgeDroppedUi1dControls(terminal) {
    if (!terminal?.isValid) return;
    for (const itemEntity of terminal.dimension.getEntities({
        type: "minecraft:item",
        location: terminal.location,
        maxDistance: 3,
    })) {
        try {
            const stack = itemEntity.getComponent("minecraft:item")?.itemStack;
            if (stack?.typeId === UI1D_CONTROL_ITEM) itemEntity.remove();
        } catch {}
    }
}
function rollbackUi1cVirtualCraftEveryTick(e, p, s) {
    const inv = e?.getComponent("minecraft:inventory")?.container;
    if (!inv || !s) return false;
    s.virtualPlayerBaseline = s.virtualPlayerBaseline ?? {};
    let changed = false;
    for (let i = 0; i < UI1C_VIEW_SLOT_COUNT; i++) {
        const c = s.snapshot?.[i];
        if (!c?.virtualCraft) continue;
        const slot = i + UI1C_VIEW_SLOT_OFFSET;
        if (slot >= VFH_CRAFT_RECIPE_SLOTS[0]) continue;
        const cur = inv.getItem(slot),
            valid =
                !!cur &&
                cur.typeId === c.typeId &&
                cur.getLore().some((x) => String(x).includes("[VFH_CRAFTABLE]"));
        // Do not remove player inventory items by result typeId. The same typeId is used by
        // legitimate craft output, so type-based rollback cannot distinguish preview leakage.
        if (!valid) {
            const restored = markUi1cCraftable(
                makeUi1cDisplayStack({ typeId: c.typeId, total: 0, virtualCraft: true }, p),
                true,
            );
            if (restored) {
                inv.setItem(slot, restored);
                changed = true;
            }
            s.virtualCraftActivated = s.virtualCraftActivated ?? new Set();
            if (!s.virtualCraftActivated.has(c.typeId)) {
                s.virtualCraftActivated.add(c.typeId);
                system.run(() => showVirtualCraftQuantityUiFromTick(e, p, c));
            }
        }
        s.virtualPlayerBaseline[c.typeId] = countPlayerItem(p, c.typeId);
    }
    return changed;
}
function controllerLocationKey(block) {
    const l = block?.location;
    return block?.dimension && l ? `${block.dimension.id}|${l.x}|${l.y}|${l.z}` : "";
}

function formatUi1cAmount(n) {
    return n >= 1000000 ? `${Math.floor(n / 1000000)}M` : `${n}`;
}
function buildUi1cCountNameTag(a, n) {
    const x = formatUi1cAmount(a);
    return `${x}${"a".repeat(Math.max(0, 10 - x.length))}${n}`;
}
function isUi1cCountPattern(t) {
    if (!t || t.length < 11) return false;
    const p = t.substring(0, 10);
    return /^\d/.test(p) && /a+$/.test(p);
}
function cleanUi1cCountNameTag(i) {
    if (i) i.nameTag = undefined;
    return i;
}

function findCraftNodeForControllerResult(block, typeId) {
    const controllerKey = controllerLocationKey(block);
    if (!controllerKey || !typeId) return null;
    for (const cnId of Object.values(readCraftNodeIndex())) {
        const rec = readCraftNodeRecord(cnId),
            loc = rec?.location;
        if (rec?.recipe?.result?.typeId !== typeId || !loc?.dimensionId) continue;
        let cb = null;
        try {
            cb = world.getDimension(loc.dimensionId).getBlock({ x: loc.x, y: loc.y, z: loc.z });
        } catch {}
        if (!cb || cb.typeId !== "vfh:craft_node") continue;
        const net = detectCraftNodeNetwork(cb);
        if (
            !net?.connected ||
            !net.controllers?.some((x) => controllerLocationKey(x) === controllerKey)
        )
            continue;
        return { block: cb, record: rec };
    }
    return null;
}
function executePendingNetworkCraftRequest(block, request) {
    const requested = Math.max(1, Math.floor(Number(request?.amount) || 1)),
        target = findCraftNodeForControllerResult(block, request?.typeId);
    if (!target) return { ok: false, reason: "craft_node_not_found", requested, crafted: 0 };
    const recipe = target.record.recipe,
        perCraft = Math.max(1, Number(recipe.result.amount) || 1),
        cycles = Math.ceil(requested / perCraft),
        need = requiredRecipeItemsForRequest(recipe, cycles);
    const availability = checkCraftNodeRecipeAvailability(target.block);
    if (!availability?.network?.connected)
        return { ok: false, reason: "network_not_found", requested, crafted: 0 };
    // Craft against the Craft Node's own detected network graph, not merely the
    // controller-local index. This keeps the 122 rollback contract intact while making
    // ingredient extraction follow the actual network attached to the selected Craft Node.
    const craftIndex = availability.index;
    for (const [typeId, amount] of need) {
        const have = Math.max(0, Number(craftIndex?.byTypeId?.get(typeId)?.total) || 0);
        if (have < amount)
            return { ok: false, reason: "missing_ingredients", requested, crafted: 0 };
    }
    const removed = [];
    for (const [typeId, amount] of need) {
        const live = checkCraftNodeRecipeAvailability(target.block, recipe)?.index,
            r = extractFromNetworkIndex(live, typeId, amount);
        if (r.extracted !== amount) {
            for (const stack of removed)
                insertIntoSpecificNetworkIndex(
                    checkCraftNodeRecipeAvailability(target.block, recipe)?.index,
                    stack,
                );
            for (const stack of r.stacks ?? [])
                insertIntoSpecificNetworkIndex(
                    checkCraftNodeRecipeAvailability(target.block, recipe)?.index,
                    stack,
                );
            return { ok: false, reason: "extract_failed", requested, crafted: 0 };
        }
        removed.push(...r.stacks);
    }
    let remaining = cycles * perCraft,
        inserted = 0;
    try {
        const proto = new ItemStack(recipe.result.typeId, 1);
        while (remaining > 0) {
            const n = Math.min(proto.maxAmount, remaining),
                stack = new ItemStack(recipe.result.typeId, n),
                live = checkCraftNodeRecipeAvailability(target.block, recipe)?.index,
                r = insertIntoSpecificNetworkIndex(live, stack),
                rem = r.remainder?.amount ?? 0;
            (() => {})(
                `[Craft Insert] type=${recipe.result.typeId} requested=${n} inserted=${r.inserted} remainder=${rem} errors=${r.errors?.length ?? 0}`,
            );
            inserted += r.inserted;
            remaining -= r.inserted;
            if (r.remainder || r.inserted < n) break;
        }
    } catch (err) {
        (() => {})(`[Craft Insert] type=${recipe.result.typeId} exception=${err}`);
    }
    if (remaining > 0) {
        for (const stack of removed)
            insertIntoSpecificNetworkIndex(
                checkCraftNodeRecipeAvailability(target.block, recipe)?.index,
                stack,
            );
        if (inserted > 0)
            extractFromNetworkIndex(
                checkCraftNodeRecipeAvailability(target.block, recipe)?.index,
                recipe.result.typeId,
                inserted,
            );
        return { ok: false, reason: "output_full", requested, crafted: 0 };
    }
    (() => {})(
        `[Craft Insert Summary] type=${recipe.result.typeId} request=${requested} cycles=${cycles} perCraft=${perCraft} inserted=${inserted} remainder=${remaining}`,
    );
    return { ok: true, reason: "ok", requested, crafted: inserted };
}
function requiredRecipeItemsForRequest(recipe, cycles) {
    const m = new Map();
    for (const item of recipe?.pattern ?? []) {
        if (item?.typeId) m.set(item.typeId, (m.get(item.typeId) ?? 0) + cycles);
    }
    return m;
}
function craftableResultsForController(block) {
    const results = new Map(),
        controllerKey = controllerLocationKey(block);
    if (!controllerKey) return results;
    const records = readCraftNodeIndex();
    for (const cnId of Object.values(records)) {
        const rec = readCraftNodeRecord(cnId);
        const loc = rec?.location;
        if (
            !loc?.dimensionId ||
            !Number.isFinite(loc.x) ||
            !Number.isFinite(loc.y) ||
            !Number.isFinite(loc.z)
        ) {
            continue;
        }
        let cb = null;
        try {
            cb = world.getDimension(loc.dimensionId).getBlock({ x: loc.x, y: loc.y, z: loc.z });
        } catch {}
        if (!cb || cb.typeId !== "vfh:craft_node") {
            continue;
        }
        const net = detectCraftNodeNetwork(cb);
        if (!net?.connected) {
            continue;
        }
        const belongs = net.controllers?.some((x) => controllerLocationKey(x) === controllerKey);
        if (!belongs) continue;
        const available = checkCraftNodeRecipeAvailability(cb);
        if (!available.craftable || !rec.recipe?.result?.typeId) continue;
        const typeId = rec.recipe.result.typeId,
            amount = Math.max(1, Number(rec.recipe.result.amount) || 1);
        const prev = results.get(typeId);
        if (!prev || amount > prev.amount) results.set(typeId, { typeId, amount });
    }
    return results;
}
function markUi1cCraftable(stack, isCraftable) {
    if (!stack || !isCraftable) return stack;
    const tag = String(stack.nameTag ?? "");
    if (!isUi1cCountPattern(tag)) return stack;
    stack.nameTag = `${tag.substring(0, 10)}§0[VFH_CRAFTABLE]§r${tag.substring(10)}`;
    return stack;
}
function makeUi1cDisplayStack(e, p) {
    try {
        const s = new ItemStack(e.typeId, 1),
            displayTotal = e.virtualCraft ? 0 : e.total;
        s.amount = e.virtualCraft ? 1 : Math.max(1, Math.min(s.maxAmount, e.total));
        const n = ITEM_NAMES[e.typeId],
            locale = String(p?.clientSystemInfo?.locale ?? "en_US"),
            name = n
                ? locale.toLowerCase().startsWith("ja")
                    ? n.ja
                    : n.en
                : formatTypeId(e.typeId);
        s.nameTag = buildUi1cCountNameTag(displayTotal, name);
        return s;
    } catch {
        return undefined;
    }
}
function sameUi1cItem(i, c) {
    return !!i && !!c && i.typeId === c.typeId;
}
function ui1dNormalizeSearch(v) {
    return String(v ?? "")
        .trim()
        .toLocaleLowerCase();
}
function ui1dMatches(e, q) {
    q = ui1dNormalizeSearch(q);
    if (!q) return true;
    const n = ITEM_NAMES[e?.typeId];
    const id = String(e?.typeId ?? "");
    const short = id.includes(":") ? id.split(":").pop().replaceAll("_", " ") : id;
    return [id, short, n?.ja, n?.en]
        .filter(Boolean)
        .some((x) => ui1dNormalizeSearch(x).includes(q));
}
function purgeAllPlayersUi1dControlItems() {
    for (const player of world.getAllPlayers()) {
        try {
            purgeUi1dControlItems(player);
        } catch {}
    }
}
// UI buttons are display-only. Clean any button that escaped into a player inventory, independently of terminal lifecycle.
system.runInterval(() => purgeAllPlayersUi1dControlItems(), 1);
function purgeDroppedVirtualCraftItems() {
    for (const dimensionId of DIMENSION_IDS) {
        let dim;
        try {
            dim = world.getDimension(dimensionId);
        } catch {
            continue;
        }
        let entities = [];
        try {
            entities = dim.getEntities({ type: "minecraft:item" });
        } catch {
            continue;
        }
        for (const entity of entities) {
            try {
                const stack = entity.getComponent("minecraft:item")?.itemStack;
                if (stack && stack.getLore().some((x) => String(x).includes("[VFH_CRAFTABLE]"))) {
                    entity.remove();
                }
            } catch {}
        }
    }
}
system.runInterval(() => purgeDroppedVirtualCraftItems(), 1);

function ensureControls(inv, page, pages, q) {
    if (!inv.getItem(UI1D_PREV)) inv.setItem(UI1D_PREV, makeCtl("§rPrevious Page"));
    if (!inv.getItem(UI1D_NEXT)) inv.setItem(UI1D_NEXT, makeCtl("§rNext Page"));
    inv.setItem(UI1D_INFO, makeCtl(`§r${page + 1}/${pages}`));
    if (!inv.getItem(UI1D_SEARCH)) inv.setItem(UI1D_SEARCH, makeCtl(q ? `§r${q}` : "§7§oSearch"));
    if (!inv.getItem(UI1D_CLEAR)) inv.setItem(UI1D_CLEAR, makeCtl("§rClear Search"));
}

function ui1dControlActivated(inv, slot) {
    const it = inv?.getItem(slot);
    return !it || it.typeId !== UI1D_CONTROL_ITEM;
}
function ui1dPlayerHasNamedControl(p, needle) {
    const inv = p?.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;
    for (let i = 0; i < inv.size; i++) {
        const it = inv.getItem(i);
        if (it?.typeId === UI1D_CONTROL_ITEM && String(it.nameTag ?? "").includes(needle))
            return true;
    }
    return false;
}
const ui1cCommitMutexes = new Map();
async function withUi1cCommitMutex(e, work) {
    const key = ui1cKey(e),
        prev = ui1cCommitMutexes.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r)),
        tail = prev.then(() => gate);
    ui1cCommitMutexes.set(key, tail);
    await prev;
    try {
        return await work();
    } finally {
        release();
        if (ui1cCommitMutexes.get(key) === tail) ui1cCommitMutexes.delete(key);
    }
}
async function showVirtualCraftQuantityUiFromTick(e, p, c) {
    const s = ui1cGetSession(e, p);
    if (!s || !p || !e?.isValid) return false;
    let b;
    try {
        const dimId =
            s.controllerDimensionId || e.getDynamicProperty("vfh:remote_dim") || e.dimension.id;
        b = world.getDimension(dimId).getBlock(s.block);
    } catch {}
    if (b?.typeId !== NETWORK_CONTROLLER_BLOCK) return false;
    const oldKey = ui1cKey(e);
    ui1dSearchTransitions.add(oldKey);
    ui1dStopLiveLoop(e);
    // 109: quarantine the virtual display item before the terminal entity is removed / modal opens.
    // Remove only the amount above the baseline so legitimate pre-existing player stock is preserved.
    const baseline = s.virtualPlayerBaseline?.[c.typeId] ?? countPlayerItem(p, c.typeId);
    const excess = Math.max(0, countPlayerItem(p, c.typeId) - Math.max(0, baseline));
    if (excess > 0) removePlayerItemAboveBaseline(p, c.typeId, baseline, excess);
    try {
        const tinv = e.getComponent("minecraft:inventory")?.container;
        for (let i = 0; i < UI1C_VIEW_SLOT_COUNT; i++) {
            const sc = s.snapshot?.[i];
            if (sc?.virtualCraft && sc.typeId === c.typeId) {
                const sl = i + UI1C_VIEW_SLOT_OFFSET;
                if (sl < VFH_CRAFT_RECIPE_SLOTS[0]) tinv?.setItem(sl, undefined);
            }
        }
    } catch {}
    // Also remove any escaped dropped virtual display entity before opening the modal.
    try {
        for (const itemEntity of e.dimension.getEntities({
            type: "minecraft:item",
            location: e.location,
            maxDistance: 3,
        })) {
            const stack = itemEntity.getComponent("minecraft:item")?.itemStack;
            if (
                stack &&
                stack.typeId === c.typeId &&
                stack.getLore().some((x) => String(x).includes("[VFH_CRAFTABLE]"))
            )
                itemEntity.remove();
        }
    } catch {}
    vfhSavePersistentCraftState(e, p);
    try {
        e.setDynamicProperty("vfh:suppress_reconcile", true);
    } catch {}
    try {
        e.remove();
    } catch {
        ui1dSearchTransitions.delete(oldKey);
        return false;
    }
    return new Promise((resolve) =>
        system.runTimeout(async () => {
            // 111: entity removal returns the virtual display stack to the player on the following tick.
            // Remove only the tagged virtual stack before opening the quantity modal.
            try {
                const pinv = p.getComponent("minecraft:inventory")?.container;
                if (pinv) {
                    for (let i = 0; i < pinv.size; i++) {
                        const it = pinv.getItem(i);
                        if (
                            it?.typeId === c.typeId &&
                            String(it.nameTag ?? "").includes("[VFH_CRAFTABLE]")
                        )
                            pinv.setItem(i, undefined);
                    }
                }
            } catch {}
            let ok = false;
            try {
                ok = await showVirtualCraftQuantityUi(b, e, p, c, s);
            } catch {}
            let nb;
            try {
                nb = b.dimension.getBlock({ x: b.x, y: b.y, z: b.z });
            } catch {}
            if (nb?.typeId !== NETWORK_CONTROLLER_BLOCK) {
                ui1dSearchTransitions.delete(oldKey);
                if (s.remote) remoteUi1cSessions.delete(p.id);
                else ui1cSessions.delete(oldKey);
                resolve(ok);
                return;
            }
            const wasRemote = !!s.remote || e?.typeId === "entity:remote_crafting_terminal";
            let ne;
            if (wasRemote) {
                try {
                    ne = p.dimension.spawnEntity("entity:remote_crafting_terminal", {
                        x: p.location.x,
                        y: p.location.y + 1.15,
                        z: p.location.z,
                    });
                } catch {
                    ui1dSearchTransitions.delete(oldKey);
                    resolve(ok);
                    return;
                }
                if (!vfhInitRemoteTerminal(ne, p, nb)) {
                    try {
                        ne.remove();
                    } catch {}
                    ui1dSearchTransitions.delete(oldKey);
                    resolve(ok);
                    return;
                }
                remoteCraftSessions.set(p.id, ne);
            } else {
                ne = vfhFindLocalTerminalByHome(nb);
                if (!ne?.isValid) {
                    try {
                        ne = ensureNetworkTerminal(nb);
                    } catch {
                        ui1dSearchTransitions.delete(oldKey);
                        resolve(ok);
                        return;
                    }
                }
            }
            if (ne?.isValid) {
                s.snapshot = [];
                s.pageCount = 1;
                s.entity = ne;
                s.block = { x: nb.x, y: nb.y, z: nb.z };
                s.playerId = p.id;
                s.controllerDimensionId = nb.dimension.id;
                s.remote = wasRemote;
                s.virtualCraftActivated?.delete(c.typeId);
                ui1cSessions.delete(oldKey);
                if (wasRemote) {
                    remoteUi1cSessions.set(p.id, s);
                } else {
                    ne.nameTag = "Crafting Terminal";
                    vfhSetLocalTerminalHome(ne, nb);
                    try {
                        ne.teleport(nb.center(), { dimension: nb.dimension });
                    } catch {}
                    ui1cSessions.set(ui1cKey(ne), s);
                }
                ui1dSearchTransitions.delete(oldKey);
                vfhRestorePersistentCraftState(ne, p);
                await renderUi1cTerminalSnapshotRebuild(nb, ne, p);
                ui1dStartLiveLoop(ne, p);
            } else ui1dSearchTransitions.delete(oldKey);
            resolve(ok);
        }, 5),
    );
}
async function showVirtualCraftQuantityUi(b, e, p, c, session = null) {
    if (!p?.isValid || !c?.virtualCraft) return false;
    const maxCraft = 64;
    let response;
    try {
        response = await new ModalFormData()
            .title("Craft Item")
            .label(translatedItemName(c.typeId))
            .slider("Craft amount", 1, maxCraft, { valueStep: 1, defaultValue: 1 })
            .submitButton("Craft")
            .show(p);
    } catch {
        return false;
    }
    if (response.canceled) return false;
    const amount = Math.max(
        1,
        Math.min(maxCraft, Math.floor(Number(response.formValues?.[1]) || 1)),
    );
    const s = session ?? ui1cGetSession(e, p);
    if (!s) return false;
    s.pendingNetworkCraft = { typeId: c.typeId, amount, requestedTick: system.currentTick };
    const request = s.pendingNetworkCraft,
        result = executePendingNetworkCraftRequest(b, request);
    if (result.ok) s.pendingNetworkCraft = undefined;
    try {
        p.sendMessage(
            result.ok
                ? `Craft request: ${formatTypeId(c.typeId)} x${amount}`
                : `Craft request failed: ${formatTypeId(c.typeId)} x${amount} (${result.reason})`,
        );
    } catch {}
    return result.ok;
}
async function commitUi1cPendingWithdrawalsUnlocked(b, e, p) {
    const s = ui1cGetSession(e, p),
        inv = e?.getComponent("minecraft:inventory")?.container;
    if (!s || !inv || b?.typeId !== NETWORK_CONTROLLER_BLOCK) return false;
    let changed = false;
    for (let i = 0; i < UI1C_VIEW_SLOT_COUNT; i++) {
        const c = s.snapshot?.[i];
        if (!c) continue;
        const slot = i + UI1C_VIEW_SLOT_OFFSET,
            cur = inv.getItem(slot);
        // Local Network Controller keeps the original withdrawal semantics.
        // Simple Storage-style stale-display protection is Remote Order only.
        if (s.remote) {
            // Limited Simple Storage-style reconciliation for Remote Order only.
            // A missing display slot is a legitimate player withdrawal. A different item in
            // the slot is display churn/rebuild and must never consume the stale snapshot item.
            if (cur && !sameUi1cItem(cur, c)) continue;
        }
        const taken = Math.max(0, c.amount - (sameUi1cItem(cur, c) ? cur.amount : 0));
        if (taken <= 0) continue;
        if (c.virtualCraft) {
            // The grid item is only a virtual craft launcher. Never purge by typeId here:
            // a legitimate crafted result has the same typeId and must survive after crafting.
            // Restore the launcher copy in the terminal and leave real player items alone.
            inv.setItem(
                i + UI1C_VIEW_SLOT_OFFSET,
                markUi1cCraftable(
                    makeUi1cDisplayStack({ typeId: c.typeId, total: 0, virtualCraft: true }, p),
                    true,
                ),
            );
            continue;
        }
        const r = await extractUi1cNetwork(b, c, taken);
        changed = changed || r.extracted > 0;
        if (r.extracted > 0) {
            const remaining = Math.max(0, c.amount - r.extracted);
            if (remaining > 0) s.snapshot[i] = { ...c, amount: remaining };
            else s.snapshot[i] = null;
        }
        let phantom = taken - r.extracted,
            pinv = p?.getComponent("minecraft:inventory")?.container;
        // Direct UI movement bypasses addStacksToPlayerInventory. Normalize every matching
        // player stack immediately after terminal withdrawal so Minecraft resolves its vanilla .lang name.
        for (let k = 0; pinv && k < pinv.size; k++) {
            const it = pinv.getItem(k);
            if (!it || it.typeId !== c.typeId) continue;
            if (it.nameTag !== undefined) {
                const clean = it.clone();
                clean.nameTag = undefined;
                pinv.setItem(k, clean);
            }
        }
        for (let k = 0; pinv && k < pinv.size && phantom > 0; k++) {
            const it = pinv.getItem(k);
            if (!it || it.typeId !== c.typeId) continue;
            const n = Math.min(phantom, it.amount);
            if (n === it.amount) pinv.setItem(k, undefined);
            else {
                const cp = it.clone();
                cp.amount -= n;
                cp.nameTag = undefined;
                pinv.setItem(k, cp);
            }
            phantom -= n;
        }
    }
    return changed;
}
async function commitUi1cPendingWithdrawals(b, e, p) {
    return withUi1cCommitMutex(e, async () => commitUi1cPendingWithdrawalsUnlocked(b, e, p));
}
async function renderUi1cTerminalUnlocked(b, e, p) {
    if (!e?.isValid || b?.typeId !== NETWORK_CONTROLLER_BLOCK) {
        return;
    }
    const cinv = e.getComponent("inventory")?.container;
    if (cinv) {
        vfhInitCraftControls(cinv);
    }
    const inv = e.getComponent("minecraft:inventory")?.container,
        s = ui1cGetSession(e);

    if (!inv || !s) {
        return;
    }
    if (!vfhCraftMachines.has(ui1cKey(e)) && !e.getDynamicProperty("vfh:pendingConsume"))
        vfhRefreshCraftPreview(b, e);
    let idx;
    try {
        idx = await getControllerIndex(b);
    } catch (error) {
        (() => {})(`[UI-1D] index failed: ${error}`);
        idx = null;
    }
    const physicalEntries = Array.isArray(idx?.entries) ? idx.entries : [];
    const diamondEntry = physicalEntries.find((x) => x?.typeId === "minecraft:diamond_block");
    const diamondLocations =
        diamondEntry?.locations
            ?.map((x) => `${x.scope ?? "local"}:${x.containerKey ?? "?"}:${x.amount ?? "?"}`)
            .join(",") ?? "none";
    (() => {})(
        `[Remote Reindex] terminal=${e.typeId} remote=${!!s.remote} entries=${physicalEntries.length} diamond_block=${diamondEntry?.total ?? 0} stacks=${diamondEntry?.stacks ?? 0} locations=${diamondLocations}`,
    );
    const craftableResults = craftableResultsForController(b);
    const merged = new Map(physicalEntries.map((x) => [x.typeId, x]));
    for (const craft of craftableResults.values()) {
        if (merged.has(craft.typeId)) continue;
        const key = `virtual:${craft.typeId}`;
        merged.set(key, {
            key,
            typeId: craft.typeId,
            total: 0,
            recipeAmount: craft.amount,
            stacks: 0,
            locations: [],
            virtualCraft: true,
        });
    }
    const entries = Array.from(merged.values()).sort((a, b) => a.typeId.localeCompare(b.typeId));
    const all = entries.filter((x) => ui1dMatches(x, s.query));
    s.pageCount = Math.max(1, Math.ceil(all.length / UI1C_VIEW_SLOT_COUNT));
    s.page = clampPage(s.page ?? 0, s.pageCount);
    const snap = [];
    for (let i = 0; i < UI1C_VIEW_SLOT_COUNT; i++) {
        const ent = all[s.page * UI1C_VIEW_SLOT_COUNT + i],
            slot = i + UI1C_VIEW_SLOT_OFFSET;
        if (slot >= VFH_CRAFT_RECIPE_SLOTS[0]) continue;
        if (ent) {
            const shown = markUi1cCraftable(makeUi1cDisplayStack(ent, p), !!ent.virtualCraft);
            if (ent.virtualCraft) {
                s.virtualPlayerBaseline = s.virtualPlayerBaseline ?? {};
                s.virtualPlayerBaseline[ent.typeId] = countPlayerItem(p, ent.typeId);
            }
            if (shown) {
                inv.setItem(slot, shown);
                snap[i] = {
                    typeId: ent.typeId,
                    amount: ent.virtualCraft ? 1 : (shown.amount ?? 0),
                    inventoryAmount: ent.virtualCraft ? 0 : ent.total,
                    recipeAmount: ent.recipeAmount ?? 0,
                    scope: ent.locations?.some((x) => x.scope === "remote") ? "remote" : "local",
                    bridgeIndex:
                        ent.locations?.find((x) => x.scope === "remote")?.bridgeIndex ?? null,
                    virtualCraft: !!ent.virtualCraft,
                };
            } else {
                inv.setItem(slot, undefined);
                snap[i] = null;
            }
        } else {
            inv.setItem(slot, undefined);
            snap[i] = null;
        }
    }
    ensureControls(inv, s.page, s.pageCount, s.query);
    s.snapshot = snap;
}
async function renderUi1cTerminal(b, e, p) {
    return withUi1cCommitMutex(e, async () => {
        await commitUi1cPendingWithdrawalsUnlocked(b, e, p);
        return renderUi1cTerminalUnlocked(b, e, p);
    });
}
async function renderUi1cTerminalSnapshotRebuild(b, e, p) {
    return withUi1cCommitMutex(e, async () => renderUi1cTerminalUnlocked(b, e, p));
}
async function extractUi1cNetwork(b, c, a) {
    if (!c || a <= 0) return { extracted: 0, stacks: [], errors: [] };
    if (c.virtualCraft)
        return { extracted: 0, stacks: [], errors: ["virtual_craft_not_extractable"] };
    if (c.scope === "remote" && c.bridgeIndex !== null) {
        const r = await resolveRemoteMutationIndexLoaded(b, c.bridgeIndex);
        if (!r?.index) return { extracted: 0, stacks: [], errors: ["remote_bridge_unavailable"] };
        return extractFromNetworkIndex(r.index, c.typeId, a);
    }
    return extractControllerNetworkItem(b, c.typeId, a);
}
async function depositUi1cImportSlot(b, e, p) {
    const inv = e.getComponent("minecraft:inventory")?.container,
        item = inv?.getItem(0);
    if (!inv || !item || item.typeId === UI1D_CONTROL_ITEM) return false;
    if (item.getLore().some((x) => String(x).includes("[VFH_CRAFTABLE]"))) {
        inv.setItem(0, undefined);
        return true;
    }
    let remainder = item.clone(),
        inserted = 0;
    inv.setItem(0, undefined);
    const session = ui1cGetSession(e);
    if (session?.remote) {
        // v1.7.0-194: use the existing loaded topology resolver. The previous
        // discoverControllerRemoteBridges symbol never existed and caused a
        // ReferenceError during Remote Order deposit.
        const topology = await discoverRemoteStorageTopologyLoaded(b);
        const bridges = topology?.bridges ?? [];
        for (let i = 0; i < bridges.length && remainder; i++) {
            const resolved = await resolveRemoteMutationIndexLoaded(b, i);
            if (!resolved?.ok || !resolved.index) continue;
            const r = insertIntoSpecificNetworkIndex(resolved.index, remainder);
            inserted += r.inserted;
            remainder = r.remainder;
        }
    }
    // Explicit fallback requested: unavailable/full remote -> local network.
    if (remainder) {
        const r = insertControllerNetworkItem(b, remainder);
        inserted += r.inserted;
        remainder = r.remainder;
    }
    if (remainder) {
        try {
            inv.setItem(0, remainder);
        } catch {
            if (p) {
                const restored = addStacksToPlayerInventory(p, [remainder]);
                for (const left of restored.leftovers ?? []) {
                    try {
                        p.dimension.spawnItem(left, p.location);
                    } catch {}
                }
            }
        }
    }
    return inserted > 0;
}
async function reconcileUi1cTerminal(e, p) {
    const s = ui1cGetSession(e, p);
    let b;
    try {
        const dimId =
            s?.controllerDimensionId || e.getDynamicProperty("vfh:remote_dim") || e.dimension.id;
        b = s && world.getDimension(dimId).getBlock(s.block);
    } catch {}
    if (!s || b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    await depositUi1cImportSlot(b, e, p);
    await commitUi1cPendingWithdrawals(
        b,
        e,
        p,
    ); /* slots 60..70 are craft-owned: no automatic delivery/transfer */
}

// Search lifecycle is deliberately split. Remote keeps the v42 behavior intact;
// Local uses its own persistent-controller-terminal transition and never calls Remote cleanup.
async function openRemoteUi1cSearch(p, e, b) {
    const old = ui1cGetSession(e, p);
    if (!old || !p || !e?.isValid || b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const dim = b.dimension,
        loc = { x: b.x, y: b.y, z: b.z };
    let ownerId = p.id;
    try {
        ownerId = e.getDynamicProperty(VFH_REMOTE_OWNER) || p.id;
    } catch {}
    // SimpleStorage lifecycle: destroy the old display entity and every old display baseline first.
    ui1dStopLiveLoop(e);
    try {
        e.setDynamicProperty("vfh:suppress_reconcile", true);
    } catch {}
    try {
        e.remove();
    } catch {
        return;
    }
    remoteCraftSessions.delete(ownerId);
    remoteUi1cSessions.delete(ownerId);
    if (p?.id) ui1dPendingSearch.delete(p.id);
    // Create a completely fresh entity/session before opening the form. No old snapshot/query/page survives.
    let ne;
    try {
        ne = p.dimension.spawnEntity("entity:remote_crafting_terminal", {
            x: p.location.x,
            y: p.location.y + 1.15,
            z: p.location.z,
        });
    } catch {
        return;
    }
    vfhInitRemoteTerminal(ne, p, b);
    remoteCraftSessions.set(ownerId, ne);
    const fresh = {
        entity: ne,
        block: loc,
        playerId: ownerId,
        snapshot: [],
        page: 0,
        pageCount: 1,
        query: "",
        remote: true,
        controllerDimensionId: dim.id,
    };
    remoteUi1cSessions.set(ownerId, fresh);
    system.runTimeout(async () => {
        let r;
        try {
            r = await new ModalFormData()
                .title("Search")
                .textField("Item name / ID:", "Diamond / ダイヤ / minecraft:diamond")
                .show(p);
        } catch (error) {
            (() => {})(`[UI-1D] remote search form failed: ${error}`);
            return;
        }
        // SimpleStorage behavior: Cancel/empty input performs no render, no reconcile, no commit, no live-loop restart.
        if (r?.canceled || !r?.formValues?.[0]) return;
        if (!ne?.isValid) return;
        fresh.query = String(r.formValues[0]).trim();
        fresh.page = 0;
        // Search result becomes visible on the next terminal open, built from a fresh display baseline.
    }, 5);
}
async function openLocalUi1cSearch(p, e, b) {
    const old = ui1cGetSession(e, p);
    if (!old || !p || !e?.isValid || b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const dim = b.dimension,
        loc = { x: b.x, y: b.y, z: b.z },
        oldKey = ui1cKey(e);
    ui1dSearchTransitions.add(oldKey);
    ui1dStopLiveLoop(e);
    vfhSavePersistentCraftState(e, p);
    try {
        e.setDynamicProperty("vfh:suppress_reconcile", true);
    } catch {}
    try {
        e.remove();
    } catch (error) {
        ui1dSearchTransitions.delete(oldKey);
        return;
    }
    system.runTimeout(async () => {
        let r;
        try {
            r = await new ModalFormData()
                .title("Search")
                .textField("Item name / ID:", "Diamond / ダイヤ / minecraft:diamond")
                .show(p);
        } catch (error) {
            (() => {})(`[UI-1D] local search form failed: ${error}`);
            ui1dSearchTransitions.delete(oldKey);
            return;
        }
        let nb;
        try {
            nb = dim.getBlock(loc);
        } catch {}
        if (nb?.typeId !== NETWORK_CONTROLLER_BLOCK) {
            ui1dSearchTransitions.delete(oldKey);
            ui1cSessions.delete(oldKey);
            return;
        }
        const q = r?.canceled ? (old.query ?? "") : String(r?.formValues?.[0] ?? "").trim();
        old.query = q;
        old.page = 0;
        let ne = vfhFindLocalTerminalByHome(nb);
        if (!ne?.isValid) {
            try {
                ne = ensureNetworkTerminal(nb);
            } catch (error) {
                ui1dSearchTransitions.delete(oldKey);
                return;
            }
        }
        if (!ne?.isValid) {
            ui1dSearchTransitions.delete(oldKey);
            return;
        }
        ne.nameTag = "Crafting Terminal";
        vfhSetLocalTerminalHome(ne, nb);
        try {
            ne.teleport(nb.center(), { dimension: nb.dimension });
        } catch {}
        old.snapshot = [];
        old.pageCount = 1;
        old.entity = ne;
        old.block = loc;
        old.playerId = p.id;
        old.controllerDimensionId = nb.dimension.id;
        old.remote = false;
        ui1cSessions.delete(oldKey);
        ui1cSessions.set(ui1cKey(ne), old);
        ui1dSearchTransitions.delete(oldKey);
        vfhRestorePersistentCraftState(ne, p);
        await renderUi1cTerminalSnapshotRebuild(nb, ne, p);
        ui1dStartLiveLoop(ne, p);
    }, 5);
}
async function openUi1cSearch(p, e, b) {
    return e?.typeId === "entity:remote_crafting_terminal"
        ? openRemoteUi1cSearch(p, e, b)
        : openLocalUi1cSearch(p, e, b);
}

function ui1dStartLiveLoop(e, p) {
    const key = ui1cKey(e);
    if (ui1dLiveLoops.has(key)) return;
    const id = system.runInterval(() => {
        try {
            if (!e?.isValid) {
                const dead = ui1dLiveLoops.get(key);
                if (dead !== undefined) {
                    try {
                        system.clearRun(dead);
                    } catch {}
                    ui1dLiveLoops.delete(key);
                }
                ui1dControlLocks.delete(key);
                vfhCraftMachines.delete(key);
                return;
            }
            const s = ui1cGetSession(e, p);
            if (!s) return;
            let inv;
            try {
                inv = e.getComponent("minecraft:inventory")?.container;
            } catch {
                const dead = ui1dLiveLoops.get(key);
                if (dead !== undefined) {
                    try {
                        system.clearRun(dead);
                    } catch {}
                    ui1dLiveLoops.delete(key);
                }
                ui1dControlLocks.delete(key);
                vfhCraftMachines.delete(key);
                return;
            }
            if (!inv) return;
            let b;
            try {
                const dimId =
                    s.controllerDimensionId ||
                    e.getDynamicProperty("vfh:remote_dim") ||
                    e.dimension.id;
                b = world.getDimension(dimId).getBlock(s.block);
            } catch {}
            if (b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
            rollbackUi1cVirtualCraftEveryTick(e, p, s);
            const prev =
                    ui1dControlActivated(inv, UI1D_PREV) ||
                    ui1dPlayerHasNamedControl(p, "Previous Page"),
                next =
                    ui1dControlActivated(inv, UI1D_NEXT) ||
                    ui1dPlayerHasNamedControl(p, "Next Page"),
                search = ui1dControlActivated(inv, UI1D_SEARCH),
                clear = ui1dControlActivated(inv, UI1D_CLEAR),
                imported = !!inv.getItem(0),
                clearCraft =
                    ui1dControlActivated(inv, VFH_CRAFT_CLEAR_SLOT) ||
                    ui1dPlayerHasNamedControl(p, "Clear Recipe");
            const currentCraftOutput = inv.getItem(VFH_CRAFT_OUTPUT_SLOT),
                expectedCraftOutput = s.craftOutput;
            const manualOutputTaken =
                !!e.getDynamicProperty("vfh:craftPreview") && !currentCraftOutput;
            if (manualOutputTaken) {
                e.setDynamicProperty("vfh:craftPreview", false);
                e.setDynamicProperty("vfh:pendingConsume", undefined);
                e.setDynamicProperty("vfh:armedConsume", undefined);
                e.setDynamicProperty("vfh:outputRecipeKey", undefined);
                s.craftOutput = undefined;
                s.craftConsume = [];
                s.craftPreviewKey = undefined;
            } else if (currentCraftOutput && !expectedCraftOutput) {
                s.craftOutput = currentCraftOutput.clone();
            }
            const recipeChanged = vfhCraftKey(inv) !== (e.getDynamicProperty("vfh:craftKey") ?? "");
            const craftTicked = vfhTickCraftMachine(b, e);
            if (!vfhCraftMachines.has(key) && !e.getDynamicProperty("vfh:pendingConsume"))
                vfhRefreshCraftPreview(b, e);
            let stockTaken = false;
            for (let i = 0; i < UI1C_VIEW_SLOT_COUNT; i++) {
                const c = s.snapshot?.[i];
                if (!c) continue;
                const cur = inv.getItem(i + UI1C_VIEW_SLOT_OFFSET);
                if (c.amount - (sameUi1cItem(cur, c) ? cur.amount : 0) > 0) {
                    stockTaken = true;
                    break;
                }
            }
            if (!(
                prev ||
                next ||
                search ||
                clear ||
                imported ||
                clearCraft ||
                recipeChanged ||
                craftTicked ||
                stockTaken
            )) {
                purgeUi1dControlItems(p);
                purgeDroppedUi1dControls(e);
                return;
            }
            if (ui1dControlLocks.has(key)) return;
            ui1dControlLocks.add(key);
            system.run(async () => {
                try {
                    if (!e?.isValid) return;
                    if (stockTaken) {
                        await withUi1cCommitMutex(e, async () => {
                            await commitUi1cPendingWithdrawalsUnlocked(b, e, p);
                            await renderUi1cTerminalUnlocked(b, e, p);
                        });
                        purgeUi1dControlItems(p);
                        purgeDroppedUi1dControls(e);
                        return;
                    }
                    if (imported) await depositUi1cImportSlot(b, e, p);
                    if (search && p) {
                        await openUi1cSearch(p, e, b);
                        return;
                    }
                    if (prev || next) {
                        await withUi1cCommitMutex(e, async () => {
                            await commitUi1cPendingWithdrawalsUnlocked(b, e, p);
                            if (prev) s.page = Math.max(0, (s.page ?? 0) - 1);
                            else
                                s.page = Math.min(
                                    Math.max(0, (s.pageCount ?? 1) - 1),
                                    (s.page ?? 0) + 1,
                                );
                            await renderUi1cTerminalUnlocked(b, e, p);
                        });
                    }
                    if (clear) {
                        s.query = "";
                        s.page = 0;
                        if (p?.id) ui1dPendingSearch.delete(p.id);
                        inv.setItem(UI1D_SEARCH, makeCtl("§7§oSearch"));
                    }
                    if (clearCraft) {
                        vfhStopCraftMachine(e, false);
                        for (const sl of VFH_CRAFT_RECIPE_SLOTS) inv.setItem(sl);
                        e.setDynamicProperty("vfh:craftKey", undefined);
                        vfhResetCraftProperties(e);
                    }
                    if (recipeChanged || clearCraft) vfhRefreshCraftPreview(b, e);
                    if (clear || imported || clearCraft) await renderUi1cTerminal(b, e, p);
                    purgeUi1dControlItems(p);
                    purgeDroppedUi1dControls(e);
                } finally {
                    ui1dControlLocks.delete(key);
                }
            });
        } catch (error) {
            ui1dControlLocks.delete(key);
            (() => {})(`[UI-1D] live loop failed: ${error}`);
        }
    }, 1);
    ui1dLiveLoops.set(key, id);
}
function ui1dStopLiveLoop(e) {
    let k;
    try {
        k = ui1cKey(e);
    } catch {
        return;
    }
    if (e?.isValid) vfhStopCraftMachine(e, false);
    else vfhCraftMachines.delete(k);
    const id = ui1dLiveLoops.get(k);
    if (id !== undefined) {
        try {
            system.clearRun(id);
        } catch {}
        ui1dLiveLoops.delete(k);
    }
    ui1dControlLocks.delete(k);
}
const ui1cTerminalFilter = { accessSourceFilter: { entityFilter: { type: "minecraft:player" } } };
world.afterEvents.entityContainerOpened.subscribe((ev) => {
    const e = ev.entity;
    if (e?.typeId !== NETWORK_TERMINAL_ENTITY && e?.typeId !== "entity:remote_crafting_terminal")
        return;
    const p = ev.openSource?.entity;
    let b;
    if (e.typeId === "entity:remote_crafting_terminal") {
        const q = ui1cGetSession(e, p)?.block;
        try {
            b = q
                ? world
                      .getDimension(e.getDynamicProperty("vfh:remote_dim") || e.dimension.id)
                      .getBlock(q)
                : undefined;
        } catch {}
    } else b = e.dimension.getBlock(e.location);
    if (b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    vfhRestorePersistentCraftState(e, p);
    const loc = { x: b.x, y: b.y, z: b.z },
        pending = p ? ui1dPendingSearch.get(p.id) : null,
        match =
            !!pending &&
            pending.terminalKey === ui1cKey(e) &&
            pending.remote === (e.typeId === "entity:remote_crafting_terminal") &&
            pending.block.x === loc.x &&
            pending.block.y === loc.y &&
            pending.block.z === loc.z,
        query = match ? pending.query : "";
    if (match) ui1dPendingSearch.delete(p.id);
    if (e.typeId === "entity:remote_crafting_terminal") {
        const key = p?.id || e.getDynamicProperty("vfh:remote_owner"),
            existing = key ? remoteUi1cSessions.get(key) : undefined;
        if (existing) {
            existing.entity = e;
            existing.block = loc;
            existing.playerId = key;
            existing.controllerDimensionId = b.dimension.id;
            if (match) existing.query = query;
        } else if (key)
            remoteUi1cSessions.set(key, {
                entity: e,
                block: loc,
                playerId: key,
                snapshot: [],
                page: 0,
                pageCount: 1,
                query,
                remote: true,
                controllerDimensionId: b.dimension.id,
            });
    } else {
        const existing = ui1cSessions.get(ui1cKey(e));
        if (existing) {
            existing.block = loc;
            existing.playerId = p?.id ?? existing.playerId ?? null;
            existing.controllerDimensionId = b.dimension.id;
            existing.remote = false;
            if (match) existing.query = query;
        } else
            ui1cSessions.set(ui1cKey(e), {
                block: loc,
                playerId: p?.id ?? null,
                snapshot: [],
                page: 0,
                pageCount: 1,
                query,
                remote: false,
                controllerDimensionId: b.dimension.id,
            });
    }
    system.run(() => {
        const ss = ui1cGetSession(e, p),
            freshRemote =
                e.typeId === "entity:remote_crafting_terminal" &&
                (!Array.isArray(ss?.snapshot) || ss.snapshot.length === 0);
        const render = freshRemote
            ? renderUi1cTerminalSnapshotRebuild(b, e, p)
            : renderUi1cTerminal(b, e, p);
        render.then(() => ui1dStartLiveLoop(e, p));
    });
}, ui1cTerminalFilter);
world.afterEvents.entityContainerClosed.subscribe((ev) => {
    const e = ev.entity;
    if (e?.typeId !== NETWORK_TERMINAL_ENTITY && e?.typeId !== "entity:remote_crafting_terminal")
        return;
    const p = ev.closeSource?.entity,
        key = ui1cKey(e);
    vfhSavePersistentCraftState(e, p);
    ui1dStopLiveLoop(e);
    purgeUi1dControlItems(p);
    purgeDroppedUi1dControls(e);
    if (e.typeId === "entity:remote_crafting_terminal") {
        let suppress = false;
        try {
            suppress = !!e.getDynamicProperty("vfh:suppress_reconcile");
        } catch {}
        if (suppress || ui1dSearchTransitions.has(key)) return;
        system.run(() => reconcileUi1cTerminal(e, p));
        return;
    }
    if (ui1dSearchTransitions.delete(key)) {
        ui1cSessions.delete(key);
        return;
    }
    system.run(() =>
        reconcileUi1cTerminal(e, p).finally(() => {
            ui1cSessions.delete(
                key,
            ); /* Local terminal is controller-owned and remains resident after close. It is removed only by controller break cleanup. */
        }),
    );
}, ui1cTerminalFilter);

function openNetworkControllerMenu(player, block) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const marker = ensureNetworkControllerMarker(block);
    if (!marker) return;
    const key = playerKey(player);
    if (controllerUiOpen.has(key)) return;
    controllerUiOpen.add(key);
    const form = new ActionFormData()
        .title({ translate: "vfh.ui.network_controller.title" })
        .button("Network Storage Viewer (UI-1C Terminal)")
        .button({ translate: "vfh.ui.network_controller.inventory" })
        .button("Deposit to Network");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0) {
                    const terminal = ensureNetworkTerminal(block);
                    ensureLocalUi1cSession(terminal, block, player);
                    system.run(() =>
                        renderUi1cTerminal(block, terminal, player).catch((error) =>
                            (() => {})(`[UI-1C] initial render failed: ${error}`),
                        ),
                    );
                }
                if (response.selection === 1) openNetworkInventory(player, block, 0);
                if (response.selection === 2) openControllerDepositInventory(player, block, 0);
            })
            .catch((error) => (() => {})(`[Network Controller NC-4] Main Menu UI failed: ${error}`))
            .finally(() => controllerUiOpen.delete(key)),
    );
}

world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const block = event.block;
    if (!block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    ensureNetworkControllerMarker(block);
    try {
        const terminal = ensureNetworkTerminal(block);
        vfhSetLocalTerminalHome(terminal, block);
        terminal.teleport(block.center());
    } catch (error) {
        (() => {})(`[UI-NORMAL] terminal pre-spawn failed: ${error}`);
    }
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
    const typeId =
        event.brokenBlockPermutation?.type?.id ?? event.brokenBlockPermutation?.typeId ?? "";
    if (typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const terminal = vfhFindLocalTerminalByHome(event.block) || findNetworkTerminal(event.block);
    if (terminal) {
        try {
            vfhSavePersistentCraftState(terminal);
            ui1dStopLiveLoop(terminal);
            vfhLocalTerminalParkState.delete(terminal.id);
            vfhLocalTerminalBreakParkTick.delete(terminal.id);
            terminal.remove();
        } catch {}
    }
    const marker = findMarkerAtBlock(event.block, NETWORK_CONTROLLER_ENTITY);
    if (!marker) return;
    try {
        dropEntityInventory(marker);
    } finally {
        try {
            marker.remove();
        } catch {}
    }
});

// Normal right-click is handled natively by the pre-spawned terminal entity container.
// Remote Order + Sneak right-click remains exclusively handled by remote_order.js.

// Park the local terminal while any nearby player is sneaking.
// This keeps its hitbox away from controller interactions and restores it immediately after sneak ends.
const vfhLocalTerminalParkState = new Map();
const vfhLocalTerminalBreakParkTick = new Map();
function vfhPlayerHoldingRemoteOrder(p) {
    try {
        return (
            p?.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)
                ?.typeId === VFH_REMOTE_ORDER_ID
        );
    } catch {
        return false;
    }
}
function vfhLocalTerminalHome(e) {
    try {
        const raw = e.getDynamicProperty("vfh:local_terminal_home");
        if (!raw) return null;
        const q = JSON.parse(raw);
        return q && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && q.d
            ? q
            : null;
    } catch {
        return null;
    }
}
function vfhSetLocalTerminalHome(e, b) {
    try {
        e.setDynamicProperty(
            "vfh:local_terminal_home",
            JSON.stringify({ d: b.dimension.id, x: b.x, y: b.y, z: b.z }),
        );
    } catch {}
}
function vfhParkLocalTerminal(e, p) {
    const h = vfhLocalTerminalHome(e);
    if (!h || !e?.isValid || !p?.isValid) return;
    try {
        e.teleport(
            { x: p.location.x, y: p.location.y + 10, z: p.location.z },
            { dimension: p.dimension },
        );
        vfhLocalTerminalParkState.set(e.id, p.id);
    } catch {}
}
function vfhFindLocalTerminalByHome(b) {
    for (const e of b.dimension.getEntities({ type: NETWORK_TERMINAL_ENTITY })) {
        const h = vfhLocalTerminalHome(e);
        if (h && h.d === b.dimension.id && h.x === b.x && h.y === b.y && h.z === b.z) return e;
    }
    return null;
}
function vfhLocalTerminalInventoryEmpty(e) {
    try {
        const inv = e.getComponent("minecraft:inventory")?.container;
        if (!inv) return true;
        for (let i = 0; i < inv.size; i++) if (inv.getItem(i)) return false;
        return true;
    } catch {
        return false;
    }
}
function vfhCleanupLegacyLocalTerminals() {
    for (const dimensionId of DIMENSION_IDS) {
        const dim = world.getDimension(dimensionId);
        for (const e of dim.getEntities({ type: NETWORK_TERMINAL_ENTITY })) {
            if (vfhLocalTerminalHome(e)) continue;
            const b = dim.getBlock({
                x: Math.floor(e.location.x),
                y: Math.floor(e.location.y),
                z: Math.floor(e.location.z),
            });
            if (b?.typeId === NETWORK_CONTROLLER_BLOCK) {
                const owned = vfhFindLocalTerminalByHome(b);
                if (!owned) {
                    vfhSetLocalTerminalHome(e, b);
                    try {
                        e.teleport(b.center());
                    } catch {}
                    continue;
                }
            }
            if (vfhLocalTerminalInventoryEmpty(e)) {
                try {
                    e.remove();
                } catch {}
            }
        }
    }
}
system.runTimeout(vfhCleanupLegacyLocalTerminals, 20);
function vfhStartupRebuildNetworkControllerTerminals() {
    const homes = new Map();
    for (const dimensionId of DIMENSION_IDS) {
        let dim;
        try {
            dim = world.getDimension(dimensionId);
        } catch {
            continue;
        }
        for (const e of dim.getEntities({ type: NETWORK_TERMINAL_ENTITY })) {
            const h = vfhLocalTerminalHome(e);
            if (h) homes.set(`${h.d}|${h.x}|${h.y}|${h.z}`, h);
            else {
                const x = Math.floor(e.location.x),
                    y = Math.floor(e.location.y),
                    z = Math.floor(e.location.z);
                try {
                    const b = dim.getBlock({ x, y, z });
                    if (b?.typeId === NETWORK_CONTROLLER_BLOCK)
                        homes.set(`${dimensionId}|${x}|${y}|${z}`, { d: dimensionId, x, y, z });
                } catch {}
            }
            try {
                ui1dStopLiveLoop(e);
                vfhLocalTerminalParkState.delete(e.id);
                vfhLocalTerminalBreakParkTick.delete(e.id);
                e.remove();
            } catch {}
        }
        for (const marker of dim.getEntities({ type: NETWORK_CONTROLLER_ENTITY })) {
            const x = Math.floor(marker.location.x),
                y = Math.floor(marker.location.y),
                z = Math.floor(marker.location.z);
            try {
                const b = dim.getBlock({ x, y, z });
                if (b?.typeId === NETWORK_CONTROLLER_BLOCK)
                    homes.set(`${dimensionId}|${x}|${y}|${z}`, { d: dimensionId, x, y, z });
            } catch {}
        }
    }
    ui1cSessions.clear();
    system.runTimeout(() => {
        for (const h of homes.values())
            try {
                const dim = world.getDimension(h.d),
                    b = dim.getBlock({ x: h.x, y: h.y, z: h.z });
                if (b?.typeId !== NETWORK_CONTROLLER_BLOCK) continue;
                const e = dim.spawnEntity(NETWORK_TERMINAL_ENTITY, b.center());
                e.nameTag = "Crafting Terminal";
                vfhSetLocalTerminalHome(e, b);
            } catch (error) {
                (() => {})(`[UI-NORMAL] startup terminal rebuild failed: ${error}`);
            }
    }, 1);
}
system.runTimeout(vfhStartupRebuildNetworkControllerTerminals, 20);
world.afterEvents.entityHitBlock.subscribe((ev) => {
    const p = ev.damagingEntity,
        b = ev.hitBlock;
    if (p?.typeId !== "minecraft:player" || b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
    const terminal = vfhFindLocalTerminalByHome(b) || findNetworkTerminal(b);
    if (!terminal?.isValid) return;
    vfhSetLocalTerminalHome(terminal, b);
    try {
        terminal.teleport(
            { x: p.location.x, y: p.location.y + 10, z: p.location.z },
            { dimension: p.dimension },
        );
        vfhLocalTerminalParkState.set(terminal.id, p.id);
        vfhLocalTerminalBreakParkTick.set(terminal.id, system.currentTick);
    } catch {}
});
function vfhRestoreLocalTerminal(e) {
    const h = vfhLocalTerminalHome(e);
    if (!h || !e?.isValid) return;
    try {
        const dim = world.getDimension(h.d),
            b = dim.getBlock({ x: h.x, y: h.y, z: h.z });
        if (b?.typeId !== NETWORK_CONTROLLER_BLOCK) return;
        e.teleport(b.center(), { dimension: dim });
        vfhLocalTerminalParkState.delete(e.id);
        vfhLocalTerminalBreakParkTick.delete(e.id);
    } catch {}
}
system.runInterval(() => {
    for (const dimensionId of DIMENSION_IDS) {
        const dim = world.getDimension(dimensionId);
        for (const e of dim.getEntities({ type: NETWORK_TERMINAL_ENTITY })) {
            const h = vfhLocalTerminalHome(e);
            if (!h) continue;
            let parker = null;
            for (const p of world.getAllPlayers()) {
                if (!p?.isValid || !p.isSneaking) continue;
                if (p.dimension.id !== h.d) continue;
                const dx = p.location.x - (h.x + 0.5),
                    dy = p.location.y - (h.y + 0.5),
                    dz = p.location.z - (h.z + 0.5);
                if (dx * dx + dy * dy + dz * dz <= 36) {
                    parker = p;
                    break;
                }
            }
            if (parker) vfhParkLocalTerminal(e, parker);
            else if (vfhLocalTerminalParkState.has(e.id)) {
                const bt = vfhLocalTerminalBreakParkTick.get(e.id);
                if (bt === undefined || system.currentTick - bt > 6) vfhRestoreLocalTerminal(e);
            }
        }
    }
}, 1);

// NC-2 safety sweep: keep a valid marker on each loaded controller and remove
// orphan markers without discarding their buffered inventory.
system.runInterval(() => {
    for (const dimensionId of DIMENSION_IDS) {
        const dimension = world.getDimension(dimensionId);
        for (const marker of dimension.getEntities({ type: NETWORK_CONTROLLER_ENTITY })) {
            const position = {
                x: Math.floor(marker.location.x),
                y: Math.floor(marker.location.y),
                z: Math.floor(marker.location.z),
            };
            let block;
            try {
                block = dimension.getBlock(position);
            } catch {
                continue;
            }
            if (block?.typeId === NETWORK_CONTROLLER_BLOCK) continue;
            try {
                dropEntityInventory(marker);
            } finally {
                try {
                    marker.remove();
                } catch {}
            }
        }
    }
}, 20);

const persistentCraftState = new Map();
function vfhCraftStateKey(e, p) {
    const ss = ui1cGetSession(e, p);
    if (e?.typeId === "entity:remote_crafting_terminal") {
        let owner;
        try {
            owner = e.getDynamicProperty(VFH_REMOTE_OWNER);
        } catch {}
        return `remote:${owner || p?.id || ss?.playerId || "unknown"}`;
    }
    const d = ss?.controllerDimensionId || e?.dimension?.id,
        b = ss?.block;
    if (d && b) return `local:${d}:${b.x},${b.y},${b.z}`;
    return `entity:${ui1cKey(e)}`;
}
function vfhSavePersistentCraftState(e, p) {
    const inv = e?.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    const slots = [];
    for (
        let i = VFH_CRAFT_RECIPE_SLOTS[0];
        i <= VFH_CRAFT_RECIPE_SLOTS[VFH_CRAFT_RECIPE_SLOTS.length - 1];
        i++
    ) {
        const it = inv.getItem(i);
        slots.push(it?.clone?.() ?? undefined);
    }
    persistentCraftState.set(vfhCraftStateKey(e, p), slots);
}
function vfhRestorePersistentCraftState(e, p) {
    const inv = e?.getComponent("minecraft:inventory")?.container,
        state = persistentCraftState.get(vfhCraftStateKey(e, p));
    if (!inv || !state) return;
    for (let n = 0; n < VFH_CRAFT_RECIPE_SLOTS.length && n < state.length; n++) {
        const slot = VFH_CRAFT_RECIPE_SLOTS[n],
            cur = inv.getItem(slot);
        if (!cur && state[n]) inv.setItem(slot, state[n].clone());
    }
}
const remoteCraftSessions = new Map();
const VFH_REMOTE_ORDER_ID = "vfh:remote_order",
    VFH_REMOTE_OWNER = "vfh:remote_owner",
    VFH_REMOTE_READY = "vfh:remote_ready",
    VFH_REMOTE_PARK_Y = 10,
    VFH_REMOTE_INIT_DELAY = 4;
function clearRemoteTerminalInventory(e) {
    const inv = e?.getComponent("minecraft:inventory")?.container;
    if (!inv) return false;
    try {
        for (let i = 0; i < inv.size; i++) inv.setItem(i, undefined);
        return true;
    } catch {
        return false;
    }
}
function removeRemoteTerminalSafely(e) {
    if (!e?.isValid) return true;
    vfhSavePersistentCraftState(e);
    ui1dStopLiveLoop(e);
    try {
        e.setDynamicProperty("vfh:suppress_reconcile", true);
    } catch {}
    if (!clearRemoteTerminalInventory(e)) {
        try {
            e.setDynamicProperty("vfh:suppress_reconcile", undefined);
        } catch {}
        return false;
    }
    try {
        e.remove();
        return true;
    } catch {
        try {
            e.setDynamicProperty("vfh:suppress_reconcile", undefined);
        } catch {}
        return false;
    }
}
export function endRemoteCraftSession(playerId) {
    const old = remoteCraftSessions.get(playerId);
    if (old?.isValid && !removeRemoteTerminalSafely(old)) return false;
    remoteCraftSessions.delete(playerId);
    remoteUi1cSessions.delete(playerId);
    return true;
}

function vfhInitRemoteTerminal(e, p, b) {
    if (!e?.isValid || !p) return false;
    try {
        e.setDynamicProperty(VFH_REMOTE_OWNER, p.id);
        e.nameTag = "tile.vfh:crafting_terminal.name";
        if (b) e.setDynamicProperty("vfh:remote_dim", b.dimension.id);
        let inv = e.getComponent("minecraft:inventory")?.container;
        if (!inv) return false;
        e.setDynamicProperty(VFH_REMOTE_READY, true);
        return true;
    } catch {
        return false;
    }
}
function prepareLinkedNetworkTerminal(player, block) {
    if (!player || !block || block.typeId !== NETWORK_CONTROLLER_BLOCK) return null;
    try {
        ensureNetworkControllerMarker(block);
        let e = remoteCraftSessions.get(player.id);
        if (e?.isValid && e.dimension.id !== player.dimension.id) {
            if (!removeRemoteTerminalSafely(e)) return null;
            e = undefined;
            remoteCraftSessions.delete(player.id);
            remoteUi1cSessions.delete(player.id);
        }
        if (!e?.isValid) {
            e = player.dimension.spawnEntity("entity:remote_crafting_terminal", {
                x: player.location.x,
                y: player.location.y + 1.15,
                z: player.location.z,
            });
            remoteCraftSessions.set(player.id, e);
        }
        e.setDynamicProperty(VFH_REMOTE_OWNER, player.id);
        e.nameTag = "tile.vfh:crafting_terminal.name";
        e.setDynamicProperty("vfh:remote_dim", block.dimension.id);
        let d = { x: 0, z: 1 };
        try {
            const v = player.getViewDirection(),
                n = Math.hypot(v.x, v.z);
            if (n > 0.001) d = { x: v.x / n, z: v.z / n };
        } catch {}
        const target = {
            x: player.location.x + d.x,
            y: player.location.y + 1.15,
            z: player.location.z + d.z,
        };
        const dx = e.location.x - target.x,
            dy = e.location.y - target.y,
            dz = e.location.z - target.z;
        if (dx * dx + dy * dy + dz * dz > 0.01)
            try {
                e.teleport(target);
            } catch {}
        const existingRemote = remoteUi1cSessions.get(player.id);
        if (existingRemote) {
            existingRemote.entity = e;
            existingRemote.block = { x: block.x, y: block.y, z: block.z };
            existingRemote.controllerDimensionId = block.dimension.id;
        } else
            remoteUi1cSessions.set(player.id, {
                entity: e,
                block: { x: block.x, y: block.y, z: block.z },
                playerId: player.id,
                snapshot: [],
                page: 0,
                pageCount: 1,
                query: "",
                remote: true,
                controllerDimensionId: block.dimension.id,
            });
        if (!vfhInitRemoteTerminal(e, player, block)) return null;
        vfhRestorePersistentCraftState(e, player);
        return e;
    } catch (error) {
        (() => {})(`[REMOTE-CRAFT] prepare failed: ${error}`);
        return null;
    }
}
export function prewarmLinkedNetworkTerminal(player, block) {
    return !!prepareLinkedNetworkTerminal(player, block);
}
export function openLinkedNetworkTerminal(player, block) {
    const e = prepareLinkedNetworkTerminal(player, block);
    if (!e) return false;
    system.run(() => {
        const ss = ui1cGetSession(e, player),
            fresh = !Array.isArray(ss?.snapshot) || ss.snapshot.length === 0;
        fresh
            ? renderUi1cTerminalSnapshotRebuild(block, e, player)
            : renderUi1cTerminal(block, e, player);
    });
    return true;
}
function vfhKickRemoteBootInit() {}
system.runInterval(() => {
    const validIds = new Set(world.getAllPlayers().map((p) => p.id));
    for (const playerId of [...remoteCraftSessions.keys()]) {
        if (validIds.has(playerId)) continue;
        endRemoteCraftSession(playerId);
    }
}, 20);
const VFH_REMOTE_ORPHAN_CLEANUP_INTERVAL = 100;
system.runInterval(() => {
    const activeIds = new Set(
        [...remoteCraftSessions.values()].filter((e) => e?.isValid).map((e) => e.id),
    );
    for (const dimensionId of DIMENSION_IDS) {
        let entities = [];
        try {
            entities = world
                .getDimension(dimensionId)
                .getEntities({ type: "entity:remote_crafting_terminal" });
        } catch {
            continue;
        }
        for (const e of entities) {
            if (activeIds.has(e.id)) continue;
            removeRemoteTerminalSafely(e);
        }
    }
}, VFH_REMOTE_ORPHAN_CLEANUP_INTERVAL);

// VFH terminal nameTag guard: terminal display stacks use the fixed 10-character
// count prefix. If such a stack reaches a real player inventory through direct UI
// movement, remove only that VFH display name. Ordinary renamed items are untouched.
function vfhCleanTerminalDisplayNamesFromPlayers() {
    for (const player of world.getAllPlayers()) {
        const inv = player?.getComponent("minecraft:inventory")?.container;
        if (!inv) continue;
        for (let slot = 0; slot < inv.size; slot++) {
            const item = inv.getItem(slot);
            if (!item || !isUi1cCountPattern(item.nameTag)) continue;
            try {
                const clean = item.clone();
                clean.nameTag = undefined;
                inv.setItem(slot, clean);
            } catch {}
        }
    }
}
system.runInterval(vfhCleanTerminalDisplayNamesFromPlayers, 1);

export { ensureNetworkControllerMarker };
