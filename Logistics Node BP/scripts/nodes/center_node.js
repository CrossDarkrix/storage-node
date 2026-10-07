import { world, system } from "@minecraft/server";
import { CENTER_NODE_BLOCK, CENTER_NODE_ENTITY, DIMENSION_IDS } from "../config/constants.js";
import { findMarkerAtBlock, ensureMarkerForBlock, dropEntityInventory } from "../core/marker.js";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import {
    getAdjacentContainers,
    getRoundRobinTargets,
    advanceRoundRobin,
} from "../core/container.js";
import { canTransferToTarget, moveContainerItems } from "../core/transfer.js";
import { ALL_DIRECTIONS, getNodeOutputFaces } from "../core/node_direction.js";
import { discoverNetworkGraph } from "../core/network_graph.js";
import { discoverRemoteStorageTopologyLoaded } from "../core/remote_storage_bridge.js";
import { discoverSafeNetworkStorage } from "../core/storage_discovery.js";
import { buildNetworkItemIndex } from "../core/network_item_index.js";
import {
    buildRemoteReadOnlyNetworkItemIndexLoaded,
    resolveRemoteMutationIndexLoaded,
} from "../core/remote_network_item_index.js";

const CENTER_FACE_MODES = Object.freeze([
    { translate: "vfh.ui.face.disabled" },
    { translate: "vfh.ui.face.input" },
    { translate: "vfh.ui.face.output" },
]);
function ensureCenterMarker(block) {
    const marker = ensureMarkerForBlock(block, CENTER_NODE_ENTITY, null, CENTER_NODE_BLOCK);
    if (!marker) return null;
    initializeCenterFaceProperties(marker);
    return marker;
}
const CENTER_FACE_CONFIG = Object.freeze([
    [{ translate: "vfh.ui.face.north" }, "center_face_north"],
    [{ translate: "vfh.ui.face.south" }, "center_face_south"],
    [{ translate: "vfh.ui.face.east" }, "center_face_east"],
    [{ translate: "vfh.ui.face.west" }, "center_face_west"],
    [{ translate: "vfh.ui.face.up" }, "center_face_up"],
    [{ translate: "vfh.ui.face.down" }, "center_face_down"],
]);
function normalizeCenterFaceMode(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n < CENTER_FACE_MODES.length ? n : 0;
}
function getCenterFaceMode(marker, p) {
    return normalizeCenterFaceMode(marker?.getDynamicProperty(p));
}
function setCenterFaceMode(marker, p, v) {
    marker.setDynamicProperty(p, normalizeCenterFaceMode(v));
}
function initializeCenterFaceProperties(marker) {
    if (!marker) return;
    for (const [, p] of CENTER_FACE_CONFIG) {
        if (marker.getDynamicProperty(p) === undefined) marker.setDynamicProperty(p, 0);
    }
}
world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const block = event.block;
    if (!block || block.typeId !== CENTER_NODE_BLOCK) return;
    let marker = findMarkerAtBlock(block, CENTER_NODE_ENTITY);
    if (!marker) marker = ensureMarkerForBlock(block, CENTER_NODE_ENTITY);
    else marker = ensureMarkerForBlock(block, CENTER_NODE_ENTITY);
    initializeCenterFaceProperties(marker);
});
world.afterEvents.playerBreakBlock.subscribe((event) => {
    const block = event.block;
    if (!block) return;
    const type =
        event.brokenBlockPermutation?.type?.id ?? event.brokenBlockPermutation?.typeId ?? "";
    if (type !== CENTER_NODE_BLOCK) return;
    const marker = block.dimension
        .getEntities({ type: CENTER_NODE_ENTITY })
        .find(
            (e) =>
                Math.floor(e.location.x) === block.location.x &&
                Math.floor(e.location.y) === block.location.y &&
                Math.floor(e.location.z) === block.location.z,
        );
    if (!marker) return;
    dropEntityInventory(marker);
    marker.remove();
});
// SN-10: marker_lifecycle.js owns displaced/orphan marker repair.
system.runInterval(() => {
    for (const id of DIMENSION_IDS) {
        const dimension = world.getDimension(id);
        for (const marker of dimension.getEntities({ type: CENTER_NODE_ENTITY })) {
            const pos = {
                x: Math.floor(marker.location.x),
                y: Math.floor(marker.location.y),
                z: Math.floor(marker.location.z),
            };
            const block = dimension.getBlock(pos);
            if (block && block.typeId === CENTER_NODE_BLOCK) {
                initializeCenterFaceProperties(marker);
            }
        }
    }
}, 20);
const centerFaceUiOpen = new Set(),
    centerFaceUiCooldown = new Map(),
    CENTER_FACE_UI_COOLDOWN_TICKS = 8;
function getCenterFaceUiKey(player) {
    return player?.id ?? player?.name ?? "unknown";
}
function canOpenCenterFaceUi(player) {
    const key = getCenterFaceUiKey(player);
    if (centerFaceUiOpen.has(key)) return false;
    const now = system.currentTick,
        last = centerFaceUiCooldown.get(key) ?? -1000;
    if (now - last < CENTER_FACE_UI_COOLDOWN_TICKS) return false;
    centerFaceUiCooldown.set(key, now);
    return true;
}
function openCenterFaceSettings(player, block) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK || !canOpenCenterFaceUi(player))
        return;
    const marker = ensureCenterMarker(block);
    if (!marker) {
        player.sendMessage({ translate: "vfh.ui.center.marker_missing" });
        return;
    }
    initializeCenterFaceProperties(marker);
    const key = getCenterFaceUiKey(player);
    centerFaceUiOpen.add(key);
    const form = new ModalFormData().title({ translate: "vfh.ui.center.title" });
    for (const [label, p] of CENTER_FACE_CONFIG)
        form.dropdown(label, CENTER_FACE_MODES, {
            defaultValueIndex: getCenterFaceMode(marker, p),
        });
    form.submitButton({ translate: "vfh.ui.common.save" });
    system.run(() => {
        form.show(player)
            .then((r) => {
                if (
                    r.canceled ||
                    !Array.isArray(r.formValues) ||
                    r.formValues.length !== CENTER_FACE_CONFIG.length
                )
                    return;
                for (let i = 0; i < CENTER_FACE_CONFIG.length; i++)
                    setCenterFaceMode(marker, CENTER_FACE_CONFIG[i][1], r.formValues[i]);
                player.sendMessage({ translate: "vfh.ui.center.saved" });
            })
            .catch((e) => (() => {})(`[Center Node C2] UI failed: ${e}`))
            .finally(() => {
                centerFaceUiOpen.delete(key);
                centerFaceUiCooldown.set(key, system.currentTick);
            });
    });
}
function formatNetworkItemTypeId(typeId) {
    return typeof typeId === "string" && typeId.length > 0 ? typeId : "unknown";
}
const NETWORK_INVENTORY_PAGE_SIZE = 10;
function clampNetworkInventoryPage(page, pageCount) {
    if (!Number.isInteger(page) || page < 0) return 0;
    if (page >= pageCount) return Math.max(0, pageCount - 1);
    return page;
}
const NETWORK_ITEM_DETAIL_PAGE_SIZE = 8;
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
            const leftover = inventory.addItem(stack);
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
function rollbackExtractedStacks(block, stacks) {
    let restored = 0;
    const leftovers = [];
    const errors = [];
    for (const stack of stacks) {
        const result = insertCenterNetworkItem(block, stack);
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
            remainder = container.addItem(remainder);
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

async function runCenterUiRemoteExtract(player, block, typeId, inventoryPage, amount, bridgeIndex) {
    const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) {
        player.sendMessage(`Remote extract aborted: ${resolved.reason}`);
        system.run(() => openCenterNetworkItemDetail(player, block, typeId, inventoryPage));
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
    showCenterExtractResult(
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

async function openCenterRemoteExtractAmountForm(
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
        system.run(() => openCenterNetworkItemDetail(player, block, typeId, inventoryPage));
        return;
    }
    const form = new ModalFormData()
        .title("Extract Remote Item")
        .textField(
            `${formatNetworkItemTypeId(typeId)}\nRemote Available: ${entry.total}\nAmount`,
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
                    runCenterUiRemoteExtract(
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
                (() => {})(`[Center Node SN-9D] Remote Extract Amount UI failed: ${error}`),
            ),
    );
}

function showCenterExtractResult(
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
            `${formatNetworkItemTypeId(typeId)}\n\nRequested: ${requested}\nExtracted: ${result.extracted}\nAdded to Inventory: ${delivery.delivered}\nReturned to Network: ${rollback.restored}\nErrors: ${result.errors.length + delivery.errors.length + rollback.errors.length}`,
        )
        .button("Back to Item Detail")
        .button("Back to Inventory");
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    system.run(() =>
                        openCenterNetworkItemDetail(player, block, typeId, inventoryPage),
                    );
                if (response.selection === 1)
                    system.run(() => openCenterNetworkInventory(player, block, inventoryPage));
            })
            .catch((error) => (() => {})(`[Center Node SN-6C] Extract Result UI failed: ${error}`));
    });
}
function runCenterUiExtract(player, block, typeId, inventoryPage, amount) {
    const result = extractCenterNetworkItem(block, typeId, amount);
    const delivery = addStacksToPlayerInventory(player, result.stacks);
    const rollback =
        delivery.leftovers.length > 0
            ? rollbackExtractedStacks(block, delivery.leftovers)
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
    showCenterExtractResult(
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
function openCenterExtractAmountForm(player, block, typeId, inventoryPage) {
    const item = findCenterNetworkItem(block, typeId);
    if (!item.found || item.total <= 0) {
        system.run(() => openCenterNetworkItemDetail(player, block, typeId, inventoryPage));
        return;
    }
    const form = new ModalFormData()
        .title("Extract Item")
        .textField(
            `${formatNetworkItemTypeId(typeId)}\nAvailable: ${item.total}\nAmount`,
            "1 - available",
            { defaultValue: String(Math.min(64, item.total)) },
        )
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
                system.run(() => runCenterUiExtract(player, block, typeId, inventoryPage, amount));
            })
            .catch((error) => (() => {})(`[Center Node SN-6C] Extract Amount UI failed: ${error}`));
    });
}
function groupNetworkItemLocations(locations) {
    const groups = new Map();
    for (const location of locations) {
        const key = location.containerKey;
        let group = groups.get(key);
        if (!group) {
            group = {
                containerKey: key,
                dimensionId: location.dimensionId,
                location: { ...location.location },
                containerTypeId: location.containerTypeId,
                amount: 0,
                stacks: 0,
                scope: location.scope ?? "local",
            };
            groups.set(key, group);
        }
        group.amount += location.amount;
        group.stacks += 1;
    }
    return Array.from(groups.values());
}
async function openCenterNetworkItemDetail(
    player,
    block,
    typeId,
    requestedInventoryPage = 0,
    requestedDetailPage = 0,
) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK) return;
    const readOnlyIndex = await buildRemoteReadOnlyNetworkItemIndexLoaded(block);
    const item = readOnlyIndex.byTypeId.get(typeof typeId === "string" ? typeId.trim() : "") ?? {
        found: false,
    };
    if (item.typeId) item.found = true;
    if (!item.found) {
        const form = new ActionFormData()
            .title("Item Detail")
            .body(
                `${formatNetworkItemTypeId(typeId)}\n\nThis item is no longer present in the network.`,
            )
            .button("< Back");
        system.run(() => {
            form.show(player)
                .then((response) => {
                    if (!response.canceled && response.selection === 0) {
                        system.run(() =>
                            openCenterNetworkInventory(player, block, requestedInventoryPage),
                        );
                    }
                })
                .catch((error) => (() => {})(`[Center Node SN-6] Item Detail UI failed: ${error}`));
        });
        return;
    }

    const containers = groupNetworkItemLocations(item.locations);
    const pageCount = Math.max(1, Math.ceil(containers.length / NETWORK_ITEM_DETAIL_PAGE_SIZE));
    const page = clampNetworkInventoryPage(requestedDetailPage, pageCount);
    const start = page * NETWORK_ITEM_DETAIL_PAGE_SIZE;
    const pageContainers = containers.slice(start, start + NETWORK_ITEM_DETAIL_PAGE_SIZE);
    const form = new ActionFormData()
        .title("Item Detail")
        .body(
            `${formatNetworkItemTypeId(item.typeId)}\n\nTotal: ${item.total}\nStacks: ${item.stacks}\nLocations: ${containers.length}\nPage: ${page + 1}/${pageCount}`,
        );
    const actions = [];
    for (const container of pageContainers) {
        const pos = container.location;
        form.button(
            `[${String(container.scope).toUpperCase()}] ${container.containerTypeId}\n${pos.x}, ${pos.y}, ${pos.z} | ${container.amount} items / ${container.stacks} stacks`,
        );
        actions.push({ type: "noop" });
    }
    if (page > 0) {
        form.button("< Previous");
        actions.push({ type: "detailPage", page: page - 1 });
    }
    if (page + 1 < pageCount) {
        form.button("Next >");
        actions.push({ type: "detailPage", page: page + 1 });
    }
    const hasLocalLocation = containers.some((container) => container.scope === "local");
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
    form.button("< Back to Inventory");
    actions.push({ type: "back" });

    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action || action.type === "noop") return;
                if (action.type === "detailPage") {
                    system.run(() =>
                        openCenterNetworkItemDetail(
                            player,
                            block,
                            typeId,
                            requestedInventoryPage,
                            action.page,
                        ),
                    );
                    return;
                }
                if (action.type === "extract") {
                    system.run(() =>
                        openCenterExtractAmountForm(player, block, typeId, requestedInventoryPage),
                    );
                    return;
                }
                if (action.type === "remoteExtract") {
                    system.run(() =>
                        openCenterRemoteExtractAmountForm(
                            player,
                            block,
                            typeId,
                            requestedInventoryPage,
                            action.bridgeIndex,
                        ),
                    );
                    return;
                }
                if (action.type === "back") {
                    system.run(() =>
                        openCenterNetworkInventory(player, block, requestedInventoryPage),
                    );
                }
            })
            .catch((error) => (() => {})(`[Center Node SN-6] Item Detail UI failed: ${error}`));
    });
}
async function openCenterNetworkInventory(player, block, requestedPage = 0) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK) return;
    const index = await buildRemoteReadOnlyNetworkItemIndexLoaded(block);
    const pageCount = Math.max(1, Math.ceil(index.entries.length / NETWORK_INVENTORY_PAGE_SIZE));
    const page = clampNetworkInventoryPage(requestedPage, pageCount);
    const start = page * NETWORK_INVENTORY_PAGE_SIZE;
    const end = Math.min(start + NETWORK_INVENTORY_PAGE_SIZE, index.entries.length);
    const pageEntries = index.entries.slice(start, end);
    const form = new ActionFormData()
        .title("Network Inventory")
        .body(
            `Unique Items: ${index.uniqueItems}\nTotal Items: ${index.totalItems}\nTotal Stacks: ${index.totalStacks}\nPage: ${page + 1}/${pageCount}`,
        );
    const actions = [];
    if (pageEntries.length === 0) {
        form.button("(Empty)");
        actions.push({ type: "noop" });
    } else {
        for (const entry of pageEntries) {
            form.button(
                `${formatNetworkItemTypeId(entry.typeId)}\n${entry.total} items / ${entry.stacks} stacks`,
            );
            actions.push({ type: "detail", typeId: entry.typeId, inventoryPage: page });
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
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action || action.type === "noop") return;
                if (action.type === "detail") {
                    system.run(() =>
                        openCenterNetworkItemDetail(
                            player,
                            block,
                            action.typeId,
                            action.inventoryPage,
                        ),
                    );
                    return;
                }
                if (action.type === "page") {
                    system.run(() => openCenterNetworkInventory(player, block, action.page));
                }
            })
            .catch((error) =>
                (() => {})(`[Center Node SN-6] Network Inventory UI failed: ${error}`),
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
function showCenterRemoteDepositResult(
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
            `${formatNetworkItemTypeId(typeId)}\n\nRemote Bridge: ${bridgeIndex + 1}\nRequested: ${requested}\nRemoved from Inventory: ${removed}\nInserted to Remote Network: ${inserted}\nReturned to Inventory: ${returned}\nErrors: ${errors}`,
        )
        .button("Back to Deposit")
        .button("Network Inventory");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    system.run(() => openCenterDepositInventory(player, block, requestedPage));
                if (response.selection === 1)
                    system.run(() => openCenterNetworkInventory(player, block));
            })
            .catch((error) =>
                (() => {})(`[Center Node SN-9E] Remote Deposit Result UI failed: ${error}`),
            ),
    );
}

async function runCenterUiRemoteDeposit(player, block, typeId, requestedPage, amount, bridgeIndex) {
    // Resolve before removing anything from the player. This guarantees a broken
    // bridge cannot consume player inventory.
    let resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) {
        player.sendMessage(`Remote deposit aborted: ${resolved.reason}`);
        system.run(() => openCenterDepositInventory(player, block, requestedPage));
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
                (() => {})(`[Center Node SN-9E] Remote Deposit fallback drop failed: ${error}`);
            }
        }
    }
    showCenterRemoteDepositResult(
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

async function openCenterRemoteDepositAmountForm(
    player,
    block,
    typeId,
    requestedPage,
    bridgeIndex,
) {
    const entry = collectPlayerDepositEntries(player).find((item) => item.typeId === typeId);
    if (!entry || entry.total <= 0) {
        player.sendMessage("That item is no longer in your inventory.");
        system.run(() => openCenterDepositInventory(player, block, requestedPage));
        return;
    }
    const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
    if (!resolved.ok) {
        player.sendMessage(`Remote deposit unavailable: ${resolved.reason}`);
        system.run(() => openCenterDepositInventory(player, block, requestedPage));
        return;
    }
    const form = new ModalFormData()
        .title("Deposit Remote Item")
        .textField(
            `${formatNetworkItemTypeId(typeId)}\nRemote Bridge: ${bridgeIndex + 1}\nAvailable: ${entry.total}\nAmount`,
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
                    runCenterUiRemoteDeposit(
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
                (() => {})(`[Center Node SN-9E] Remote Deposit Amount UI failed: ${error}`),
            ),
    );
}

async function openCenterDepositTargetForm(player, block, typeId, requestedPage) {
    const topology = await discoverRemoteStorageTopologyLoaded(block);
    const availableRemoteBridges = [];
    for (let bridgeIndex = 0; bridgeIndex < (topology?.bridges?.length ?? 0); bridgeIndex++) {
        const resolved = await resolveRemoteMutationIndexLoaded(block, bridgeIndex);
        if (resolved.ok) availableRemoteBridges.push(bridgeIndex);
    }
    if (availableRemoteBridges.length === 0) {
        system.run(() => openCenterDepositAmountForm(player, block, typeId, requestedPage));
        return;
    }
    const form = new ActionFormData()
        .title("Deposit Target")
        .body(`${formatNetworkItemTypeId(typeId)}\n\nSelect destination network.`)
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
                        openCenterDepositAmountForm(player, block, typeId, requestedPage),
                    );
                if (action.type === "remote")
                    system.run(() =>
                        openCenterRemoteDepositAmountForm(
                            player,
                            block,
                            typeId,
                            requestedPage,
                            action.bridgeIndex,
                        ),
                    );
                if (action.type === "back")
                    system.run(() => openCenterDepositInventory(player, block, requestedPage));
            })
            .catch((error) => (() => {})(`[Center Node SN-9E] Deposit Target UI failed: ${error}`)),
    );
}

function showCenterDepositResult(
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
            `${formatNetworkItemTypeId(typeId)}\n\nRequested: ${requested}\nRemoved from Inventory: ${removed}\nInserted to Network: ${inserted}\nReturned to Inventory: ${returned}\nErrors: ${errors}`,
        )
        .button("Back to Deposit")
        .button("Network Inventory");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0)
                    system.run(() => openCenterDepositInventory(player, block, requestedPage));
                if (response.selection === 1)
                    system.run(() => openCenterNetworkInventory(player, block));
            })
            .catch((error) => (() => {})(`[Center Node SN-7B] Deposit Result UI failed: ${error}`)),
    );
}
function runCenterUiDeposit(player, block, typeId, requestedPage, amount) {
    const removal = removePlayerInventoryItem(player, typeId, amount);
    let inserted = 0;
    let returned = 0;
    let errors = removal.errors.length;
    const returnStacks = [];
    for (const stack of removal.stacks) {
        const result = insertCenterNetworkItem(block, stack);
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
                (() => {})(`[Center Node SN-7B] Deposit fallback drop failed: ${error}`);
            }
        }
    }
    showCenterDepositResult(
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
function openCenterDepositAmountForm(player, block, typeId, requestedPage = 0) {
    const entry = collectPlayerDepositEntries(player).find((item) => item.typeId === typeId);
    if (!entry || entry.total <= 0) {
        player.sendMessage("That item is no longer in your inventory.");
        system.run(() => openCenterDepositInventory(player, block, requestedPage));
        return;
    }
    const form = new ModalFormData()
        .title("Deposit Item")
        .textField(
            `${formatNetworkItemTypeId(typeId)}\nAvailable: ${entry.total}\nAmount`,
            "1 - available",
            { defaultValue: String(Math.min(64, entry.total)) },
        )
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
                system.run(() => runCenterUiDeposit(player, block, typeId, requestedPage, amount));
            })
            .catch((error) => (() => {})(`[Center Node SN-7B] Deposit Amount UI failed: ${error}`));
    });
}
function openCenterDepositInventory(player, block, requestedPage = 0) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK) return;
    const entries = collectPlayerDepositEntries(player);
    const pageCount = Math.max(1, Math.ceil(entries.length / NETWORK_DEPOSIT_PAGE_SIZE));
    const page = clampNetworkInventoryPage(requestedPage, pageCount);
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
                `${formatNetworkItemTypeId(entry.typeId)}\n${entry.total} items / ${entry.stacks} stacks`,
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
    form.button("< Back to Center Node");
    actions.push({ type: "back" });
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                const action = actions[response.selection];
                if (!action || action.type === "noop") return;
                if (action.type === "item") {
                    system.run(() =>
                        openCenterDepositTargetForm(player, block, action.typeId, action.page),
                    );
                    return;
                }
                if (action.type === "page") {
                    system.run(() => openCenterDepositInventory(player, block, action.page));
                    return;
                }
                if (action.type === "back") {
                    const key = getCenterFaceUiKey(player);
                    centerFaceUiOpen.delete(key);
                    centerFaceUiCooldown.set(
                        key,
                        system.currentTick - CENTER_FACE_UI_COOLDOWN_TICKS,
                    );
                    system.run(() => openCenterMainMenu(player, block));
                }
            })
            .catch((error) =>
                (() => {})(`[Center Node SN-7A] Deposit Inventory UI failed: ${error}`),
            );
    });
}
function openCenterModeSettings(player, block) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK) return;
    const marker = ensureCenterMarker(block);
    if (!marker) {
        player.sendMessage({ translate: "vfh.ui.center.marker_missing" });
        return;
    }
    initializeCenterFaceProperties(marker);
    const form = new ModalFormData().title({ translate: "vfh.ui.center.title" });
    for (const [label, property] of CENTER_FACE_CONFIG) {
        form.dropdown(label, CENTER_FACE_MODES, {
            defaultValueIndex: getCenterFaceMode(marker, property),
        });
    }
    form.submitButton({ translate: "vfh.ui.common.save" });
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (
                    response.canceled ||
                    !Array.isArray(response.formValues) ||
                    response.formValues.length !== CENTER_FACE_CONFIG.length
                )
                    return;
                for (let i = 0; i < CENTER_FACE_CONFIG.length; i++) {
                    setCenterFaceMode(marker, CENTER_FACE_CONFIG[i][1], response.formValues[i]);
                }
                player.sendMessage({ translate: "vfh.ui.center.saved" });
            })
            .catch((error) => (() => {})(`[Center Node Face Settings] UI failed: ${error}`)),
    );
}
function formatSn9aBridgeDiagnostic(bridge, index) {
    const source = bridge?.source;
    const result = bridge?.result;
    const role = bridge?.role ?? result?.role ?? "unknown";
    const isReceive = role === "receive";
    const sourceBlock = source?.block;
    const sourcePos = sourceBlock?.location;
    const remotePos = result?.remoteEnderBlock?.location;
    const lines = [`Bridge ${index + 1}`];
    lines.push(`Role: ${role === "send" ? "SEND" : isReceive ? "RECEIVE" : "UNKNOWN"}`);
    lines.push(
        `Local Ender: ${sourceBlock ? "OK" : "NG"}${sourcePos ? ` (${sourcePos.x}, ${sourcePos.y}, ${sourcePos.z})` : ""}`,
    );
    lines.push(`Channel: ${result?.channel || "(empty)"}`);
    if (isReceive) {
        lines.push(
            `Incoming SEND: ${result?.incoming && result?.remoteEnderBlock ? "FOUND" : "NOT FOUND"}`,
        );
    } else {
        lines.push(`Target: ${result?.target ? "OK" : "NG"}`);
    }
    lines.push(`Status: ${result?.ok ? "OK" : "NG"} (${result?.reason ?? "unknown"})`);
    if (result?.inspection) {
        lines.push(`Remote Chunk: ${result.inspection.loaded ? "LOADED" : "NOT LOADED"}`);
        lines.push(`Remote Block: ${result.inspection.blockPresent ? "OK" : "NG"}`);
        lines.push(`Remote Marker: ${result.inspection.markerPresent ? "OK" : "NG"}`);
    }
    if (result?.remoteEnderBlock) {
        lines.push(
            `${isReceive ? "Remote SEND" : "Remote RECEIVE"}: OK${remotePos ? ` (${result.remoteEnderBlock.dimension.id} ${remotePos.x}, ${remotePos.y}, ${remotePos.z})` : ""}`,
        );
    } else {
        lines.push(`${isReceive ? "Remote SEND" : "Remote RECEIVE"}: NG`);
    }
    if (result?.remoteGraph) {
        const storageNodes = result.remoteGraph.nodes.filter(
            (node) => node?.typeId === "vfh:storage_node",
        ).length;
        lines.push("Remote Network: FOUND");
        lines.push(`Remote Nodes: ${result.remoteGraph.nodes.length}`);
        lines.push(`Remote Storage Nodes: ${storageNodes}`);
        lines.push(`Remote Edges: ${result.remoteGraph.edges.length}`);
    } else {
        lines.push("Remote Network: NOT FOUND");
    }
    return lines.join("\n");
}

async function openCenterRemoteStorageDiagnostic(player, block) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK) return;
    const topology = await discoverRemoteStorageTopologyLoaded(block);
    const bridges = topology?.bridges ?? [];
    const body =
        bridges.length === 0
            ? `SN-9A Remote Storage Topology\n\nLocal Nodes: ${topology?.localGraph?.nodes?.length ?? 0}\nEnder Bridges: 0\n\nNo Ender Node is directly attached to the local Storage Network.`
            : `SN-9A Remote Storage Topology\n\nLocal Nodes: ${topology?.localGraph?.nodes?.length ?? 0}\nEnder Bridges: ${bridges.length}\n\n${bridges.map(formatSn9aBridgeDiagnostic).join("\n\n")}`;
    const form = new ActionFormData()
        .title("Remote Storage Diagnostic")
        .body(body)
        .button("Refresh")
        .button("< Back to Center Node");
    system.run(() =>
        form
            .show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0) {
                    system.run(() => openCenterRemoteStorageDiagnostic(player, block));
                    return;
                }
                if (response.selection === 1) {
                    const key = getCenterFaceUiKey(player);
                    centerFaceUiOpen.delete(key);
                    centerFaceUiCooldown.set(
                        key,
                        system.currentTick - CENTER_FACE_UI_COOLDOWN_TICKS,
                    );
                    system.run(() => openCenterMainMenu(player, block));
                }
            })
            .catch((error) =>
                (() => {})(`[Center Node SN-9A] Remote Storage Diagnostic UI failed: ${error}`),
            ),
    );
}

function openCenterMainMenu(player, block) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK || !canOpenCenterFaceUi(player))
        return;
    const marker = ensureCenterMarker(block);
    if (!marker) {
        player.sendMessage({ translate: "vfh.ui.center.marker_missing" });
        return;
    }
    const key = getCenterFaceUiKey(player);
    centerFaceUiOpen.add(key);
    const form = new ActionFormData()
        .title("Center Node")
        .button("Network Inventory")
        .button("Deposit to Network")
        .button("Remote Storage Diagnostic")
        .button("Face Settings");
    system.run(() => {
        form.show(player)
            .then((response) => {
                if (response.canceled || response.selection === undefined) return;
                if (response.selection === 0) {
                    openCenterNetworkInventory(player, block);
                    return;
                }
                if (response.selection === 1) {
                    openCenterDepositInventory(player, block);
                    return;
                }
                if (response.selection === 2) {
                    openCenterRemoteStorageDiagnostic(player, block);
                    return;
                }
                if (response.selection === 3) {
                    openCenterModeSettings(player, block);
                    return;
                }
                if (response.selection === 4) {
                    centerFaceUiOpen.delete(key);
                    centerFaceUiCooldown.set(
                        key,
                        system.currentTick - CENTER_FACE_UI_COOLDOWN_TICKS,
                    );
                    openCenterFaceSettings(player, block);
                }
            })
            .catch((error) => (() => {})(`[Center Node SN-6] Main Menu UI failed: ${error}`))
            .finally(() => {
                centerFaceUiOpen.delete(key);
                centerFaceUiCooldown.set(key, system.currentTick);
            });
    });
}
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block,
        player = event.player;
    if (!block || block.typeId !== CENTER_NODE_BLOCK || !player?.isSneaking) return;
    const selected = player
        .getComponent("minecraft:inventory")
        ?.container?.getItem(player.selectedSlotIndex);
    if (selected) return;
    event.cancel = true;
    const dimension = block.dimension;
    const location = { x: block.location.x, y: block.location.y, z: block.location.z };
    system.run(() => {
        try {
            const currentBlock = dimension.getBlock(location);
            if (!currentBlock || currentBlock.typeId !== CENTER_NODE_BLOCK) return;
            openCenterFaceSettings(player, currentBlock);
        } catch (error) {
            (() => {})(`[Center Node Self-Heal] ${error}`);
        }
    });
});

export function discoverCenterNetwork(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK) return { start: null, nodes: [], edges: [] };
    return discoverNetworkGraph(block);
}
export function discoverCenterStorage(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK)
        return {
            graph: { start: null, nodes: [], edges: [] },
            storageNodes: [],
            containers: [],
            rejected: [],
        };
    return discoverSafeNetworkStorage(block);
}

export function buildCenterNetworkItemIndex(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK) {
        return {
            storage: {
                graph: { start: null, nodes: [], edges: [] },
                storageNodes: [],
                containers: [],
                rejected: [],
            },
            entries: [],
            byTypeId: new Map(),
            uniqueItems: 0,
            totalStacks: 0,
            totalItems: 0,
        };
    }
    return buildNetworkItemIndex(block);
}

// SN-4A: Read-only item lookup over the SN-3 network index.
// This layer never mutates stacks or containers. It only projects index data.
export function findCenterNetworkItem(block, typeId) {
    const normalizedTypeId = typeof typeId === "string" ? typeId.trim() : "";
    if (!block || block.typeId !== CENTER_NODE_BLOCK || !normalizedTypeId) {
        return {
            found: false,
            typeId: normalizedTypeId,
            total: 0,
            stacks: 0,
            locations: [],
        };
    }

    const index = buildCenterNetworkItemIndex(block);
    const entry = index.byTypeId.get(normalizedTypeId);
    if (!entry) {
        return {
            found: false,
            typeId: normalizedTypeId,
            total: 0,
            stacks: 0,
            locations: [],
        };
    }

    return {
        found: true,
        typeId: entry.typeId,
        total: entry.total,
        stacks: entry.stacks,
        locations: entry.locations.map((location) => ({
            containerKey: location.containerKey,
            dimensionId: location.dimensionId,
            location: { ...location.location },
            containerTypeId: location.containerTypeId,
            storageNodeLocation: { ...location.storageNodeLocation },
            direction: location.direction,
            slot: location.slot,
            amount: location.amount,
        })),
    };
}

// Insert an ItemStack into the safe network storage as one logical storage.
// The caller remains responsible for the source inventory. This function only
// writes to safe network containers and reports the amount accepted/remaining.
export function insertCenterNetworkItem(block, itemStack) {
    const requested =
        Number.isInteger(itemStack?.amount) && itemStack.amount > 0 ? itemStack.amount : 0;

    if (!block || block.typeId !== CENTER_NODE_BLOCK || !itemStack || requested <= 0) {
        return {
            requested,
            inserted: 0,
            remaining: requested,
            remainder: itemStack ?? undefined,
            usedContainers: [],
            errors: [],
        };
    }

    const storage = discoverSafeNetworkStorage(block);
    let remainder = itemStack;
    const usedContainers = [];
    const errors = [];

    for (const target of storage.containers) {
        if (!remainder) break;

        const container = target?.container;
        if (!container) continue;

        try {
            if (!container.isValid) continue;

            const beforeAmount = remainder.amount;
            const nextRemainder = container.addItem(remainder);
            const afterAmount = nextRemainder?.amount ?? 0;
            const insertedHere = beforeAmount - afterAmount;

            if (insertedHere > 0) {
                usedContainers.push({
                    key: target.key,
                    dimensionId: target.dimensionId,
                    location: { ...target.location },
                    typeId: target.typeId,
                    inserted: insertedHere,
                });
            }

            remainder = nextRemainder;
        } catch (error) {
            errors.push({
                key: target.key,
                dimensionId: target.dimensionId,
                location: target.location ? { ...target.location } : null,
                typeId: target.typeId,
                error: String(error),
            });
        }
    }

    const remaining = remainder?.amount ?? 0;
    return {
        requested,
        inserted: requested - remaining,
        remaining,
        remainder,
        usedContainers,
        errors,
    };
}

// SN-5B: Extract items by typeId from safe network storage.
// The function mutates only indexed safe containers and returns the extracted
// ItemStack fragments to the caller. It never inserts them into a destination.
export function extractCenterNetworkItem(block, typeId, amount) {
    const normalizedTypeId = typeof typeId === "string" ? typeId.trim() : "";
    const requested = Number.isInteger(amount) && amount > 0 ? amount : 0;
    if (!block || block.typeId !== CENTER_NODE_BLOCK || !normalizedTypeId || requested <= 0) {
        return {
            requested,
            extracted: 0,
            remaining: requested,
            stacks: [],
            usedContainers: [],
            errors: [],
        };
    }

    const index = buildCenterNetworkItemIndex(block);
    const entry = index.byTypeId.get(normalizedTypeId);
    if (!entry) {
        return {
            requested,
            extracted: 0,
            remaining: requested,
            stacks: [],
            usedContainers: [],
            errors: [],
        };
    }

    const containersByKey = new Map(index.storage.containers.map((target) => [target.key, target]));
    const stacks = [];
    const usedByKey = new Map();
    const errors = [];
    let remaining = requested;

    for (const location of entry.locations) {
        if (remaining <= 0) break;
        const target = containersByKey.get(location.containerKey);
        const container = target?.container;
        if (!target || !container) continue;

        try {
            if (!container.isValid) continue;
            const current = container.getItem(location.slot);
            if (!current || current.typeId !== normalizedTypeId || current.amount <= 0) continue;

            const take = Math.min(remaining, current.amount);
            const extractedStack = current.clone();
            extractedStack.amount = take;

            if (take === current.amount) {
                container.setItem(location.slot, undefined);
            } else {
                const remainderStack = current.clone();
                remainderStack.amount = current.amount - take;
                container.setItem(location.slot, remainderStack);
            }

            stacks.push(extractedStack);
            remaining -= take;

            const used = usedByKey.get(target.key) ?? {
                key: target.key,
                dimensionId: target.dimensionId,
                location: { ...target.location },
                typeId: target.typeId,
                extracted: 0,
            };
            used.extracted += take;
            usedByKey.set(target.key, used);
        } catch (error) {
            errors.push({
                key: target.key,
                dimensionId: target.dimensionId,
                location: target.location ? { ...target.location } : null,
                typeId: target.typeId,
                slot: location.slot,
                error: String(error),
            });
        }
    }

    return {
        requested,
        extracted: requested - remaining,
        remaining,
        stacks,
        usedContainers: Array.from(usedByKey.values()),
        errors,
    };
}

const CENTER_TRANSFER_INTERVAL_TICKS = 1,
    CENTER_TRANSFER_AMOUNT = 64;
function getCenterMarkerInventory(block) {
    const marker = findMarkerAtBlock(block, CENTER_NODE_ENTITY);
    return { marker, container: marker?.getComponent("minecraft:inventory")?.container ?? null };
}
function runCenterTransfer(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK) return;
    const { marker, container } = getCenterMarkerInventory(block);
    if (!marker || !container) return;
    const outputFaces = getNodeOutputFaces(block);
    const excluded = ALL_DIRECTIONS.filter((d) => !outputFaces.includes(d));
    const targets = getAdjacentContainers(block, undefined, excluded, marker);
    if (!Array.isArray(targets) || targets.length === 0) return;
    const allowed = targets.filter((t) => canTransferToTarget(CENTER_NODE_ENTITY, t, block));
    if (allowed.length === 0) return;
    const ordered = getRoundRobinTargets(marker, allowed);
    for (const target of ordered) {
        const moved = moveContainerItems(container, target.container, CENTER_TRANSFER_AMOUNT);
        if (moved > 0) {
            advanceRoundRobin(marker, allowed, target);
            break;
        }
    }
}
system.runInterval(() => {
    for (const id of DIMENSION_IDS) {
        const dimension = world.getDimension(id);
        for (const marker of dimension.getEntities({ type: CENTER_NODE_ENTITY })) {
            const block = dimension.getBlock({
                x: Math.floor(marker.location.x),
                y: Math.floor(marker.location.y),
                z: Math.floor(marker.location.z),
            });
            if (block?.typeId === CENTER_NODE_BLOCK) runCenterTransfer(block);
        }
    }
}, CENTER_TRANSFER_INTERVAL_TICKS);
