import { world, system } from "@minecraft/server";
import { getBlockContainer } from "../core/container.js";
import { findMarkerAtBlock } from "../core/marker.js";
import { SIDE_NODE_BLOCK, SIDE_NODE_ENTITY } from "../config/constants.js";
import { canNodeConnectToNode } from "../core/node_direction.js";
import { ActionFormData } from "@minecraft/server-ui";

const SORT_NODE_BLOCK = "vfh:sort_node";
const SORT_REDSTONE_COMPONENT = "vfh:sort_redstone_sync";
const SORT_SETTINGS_COMPONENT = "vfh:sort_settings";
const SORT_SIDES = [
    ["north", "North / 北"],
    ["south", "South / 南"],
    ["east", "East / 東"],
    ["west", "West / 西"],
    ["down", "Down / 下"],
];

system.beforeEvents.startup.subscribe((event) => {
    event.blockComponentRegistry.registerCustomComponent(SORT_REDSTONE_COMPONENT, {
        onRedstoneUpdate(redstoneEvent) {
            const block = redstoneEvent.block;
            if (!block || block.typeId !== SORT_NODE_BLOCK) return;
            rememberSortNode(block);

            const powered = redstoneEvent.powerLevel > 0;
            const currentPowered = block.permutation.getState("vfh:sort_powered") === true;
            if (currentPowered === powered) return;

            block.setPermutation(block.permutation.withState("vfh:sort_powered", powered));
        },
    });
    event.blockComponentRegistry.registerCustomComponent(SORT_SETTINGS_COMPONENT, {
        onPlayerInteract(interactEvent) {
            const block = interactEvent.block;
            const player = interactEvent.player;
            if (!block || block.typeId !== SORT_NODE_BLOCK) return;
            rememberSortNode(block);
            if (!player?.isSneaking) return;
            system.run(() => openSortNodeSettings(player, block));
        },
    });
});

function getSortSideMode(block, side) {
    try {
        const mode = block.permutation.getState(`vfh:sort_${side}`);
        return mode === "input" ? "input" : mode === "filter" ? "filter" : "normal";
    } catch {
        return "normal";
    }
}

function setSortSideMode(block, side, mode) {
    if (!block?.isValid || block.typeId !== SORT_NODE_BLOCK) return false;
    try {
        const value = mode === "input" ? "input" : mode === "filter" ? "filter" : "normal";
        block.setPermutation(block.permutation.withState(`vfh:sort_${side}`, value));
        return true;
    } catch {
        return false;
    }
}

async function openSortNodeSettings(player, block) {
    if (!player?.isValid || !block?.isValid || block.typeId !== SORT_NODE_BLOCK) return;
    const blacklist = isSortNodePowered(block);
    const form = new ActionFormData()
        .title("Sorting Node Settings / 仕分けノード設定")
        .body(
            `Filter: UP container\nMode: ${blacklist ? "BLACKLIST (Redstone ON)" : "WHITELIST (Redstone OFF)"}`,
        );
    for (const [side, label] of SORT_SIDES)
        form.button(
            `${label}: ${getSortSideMode(block, side) === "input" ? "INPUT" : getSortSideMode(block, side) === "filter" ? "FILTER OUTPUT" : "NORMAL OUTPUT"}`,
        );
    let result;
    try {
        result = await form.show(player);
    } catch {
        return;
    }
    if (result.canceled || result.selection === undefined) return;
    const [side] = SORT_SIDES[result.selection] ?? [];
    if (!side) return;
    const current = getSortSideMode(block, side);
    const next = current === "normal" ? "filter" : current === "filter" ? "input" : "normal";
    if (!setSortSideMode(block, side, next)) return;
    system.run(() => openSortNodeSettings(player, block));
}

export function getSortNodeOutputDirections(block, filterOutput) {
    const wanted = filterOutput ? "filter" : "normal";
    return SORT_SIDES.map(([side]) => side).filter(
        (side) => getSortSideMode(block, side) === wanted,
    );
}

export function getSortNodeInputDirections(block) {
    return SORT_SIDES.map(([side]) => side).filter(
        (side) => getSortSideMode(block, side) === "input",
    );
}

export function isSortNodePowered(block) {
    return (
        !!block &&
        block.typeId === SORT_NODE_BLOCK &&
        block.permutation.getState("vfh:sort_powered") === true
    );
}

/* =========================================================
   SORT NODE FILTER MATCH / REDSTONE INVERSION
   OFF = whitelist, ON = blacklist
   The filter inventory is the container directly above the Sort Node.
========================================================= */
function getSortFilterContainer(block) {
    if (!block) return null;
    try {
        const filterBlock = block.dimension.getBlock({
            x: block.location.x,
            y: block.location.y + 1,
            z: block.location.z,
        });
        if (!filterBlock) return null;
        return filterBlock.getComponent("minecraft:inventory")?.container ?? null;
    } catch {
        return null;
    }
}

export function getSortFilterTypeIds(block) {
    const container = getSortFilterContainer(block);
    if (!container) return new Set();

    const typeIds = new Set();
    for (let slot = 0; slot < container.size; slot++) {
        const item = container.getItem(slot);
        if (item?.typeId) typeIds.add(item.typeId);
    }
    return typeIds;
}

export function evaluateSortNodeFilter(block, itemOrTypeId) {
    const typeId = typeof itemOrTypeId === "string" ? itemOrTypeId : itemOrTypeId?.typeId;
    if (!typeId) {
        return {
            valid: false,
            matched: false,
            filterOutput: false,
            normalOutput: false,
            mode: isSortNodePowered(block) ? "blacklist" : "whitelist",
        };
    }

    const filterContainer = getSortFilterContainer(block);
    if (!filterContainer) {
        return {
            valid: false,
            matched: false,
            filterOutput: false,
            normalOutput: true,
            mode: isSortNodePowered(block) ? "blacklist" : "whitelist",
        };
    }

    let matched = false;
    for (let slot = 0; slot < filterContainer.size; slot++) {
        const filterItem = filterContainer.getItem(slot);
        if (filterItem?.typeId === typeId) {
            matched = true;
            break;
        }
    }

    const blacklist = isSortNodePowered(block);
    const filterOutput = blacklist ? !matched : matched;

    return {
        valid: true,
        matched,
        filterOutput,
        normalOutput: !filterOutput,
        mode: blacklist ? "blacklist" : "whitelist",
    };
}

export function shouldRouteToSortFilterOutput(block, itemOrTypeId) {
    return evaluateSortNodeFilter(block, itemOrTypeId).filterOutput;
}

/* =========================================================
   SORT NODE BLOCK-ONLY SIDE-STYLE TRANSFER
   Side Node flow mirrored without a marker inventory:
   configured INPUT container -> route decision -> configured OUTPUT container.
========================================================= */
const SORT_TRANSFER_INTERVAL = 4;
const SORT_TRANSFER_LIMIT = 4;
const SORT_OFFSETS = Object.freeze({
    north: { x: 0, y: 0, z: -1 },
    south: { x: 0, y: 0, z: 1 },
    east: { x: 1, y: 0, z: 0 },
    west: { x: -1, y: 0, z: 0 },
    down: { x: 0, y: -1, z: 0 },
});
const activeSortNodes = new Map();
function sortNodeKey(block) {
    return `${block.dimension.id}:${block.location.x},${block.location.y},${block.location.z}`;
}
function rememberSortNode(block) {
    if (block?.typeId === SORT_NODE_BLOCK)
        activeSortNodes.set(sortNodeKey(block), {
            d: block.dimension.id,
            x: block.location.x,
            y: block.location.y,
            z: block.location.z,
        });
}
function getSortAdjacentBlock(block, side) {
    const o = SORT_OFFSETS[side];
    if (!o) return null;
    try {
        return block.dimension.getBlock({
            x: block.location.x + o.x,
            y: block.location.y + o.y,
            z: block.location.z + o.z,
        });
    } catch {
        return null;
    }
}
function getSortContainerOnSide(block, side) {
    const target = getSortAdjacentBlock(block, side);
    if (!target) return null;
    if (target.typeId === SIDE_NODE_BLOCK) {
        if (!canNodeConnectToNode(block, side, target)) return null;
        const marker = findMarkerAtBlock(target, SIDE_NODE_ENTITY);
        return marker?.getComponent("minecraft:inventory")?.container ?? null;
    }
    return getBlockContainer(target);
}
function previewAcceptedAmount(target, item, limit) {
    let n = 0;
    if (!target || !item) return 0;
    for (let i = 0; i < target.size && n < limit; i++) {
        const t = target.getItem(i);
        if (!t) {
            n += Math.min(item.maxAmount, limit - n);
            continue;
        }
        if (t.isStackableWith(item)) n += Math.min(t.maxAmount - t.amount, limit - n);
    }
    return n;
}
function insertExact(target, item, amount) {
    if (amount <= 0) return 0;
    const c = item.clone();
    c.amount = amount;
    const left = target.addItem(c);
    return amount - (left?.amount ?? 0);
}
function removeExact(source, slot, item, amount) {
    const cur = source.getItem(slot);
    if (!cur || !cur.isStackableWith(item) || cur.amount < amount) return false;
    if (cur.amount === amount) source.setItem(slot, undefined);
    else {
        cur.amount -= amount;
        source.setItem(slot, cur);
    }
    return true;
}
function rollbackExact(target, item, amount) {
    let left = amount;
    for (let slot = target.size - 1; slot >= 0 && left > 0; slot--) {
        const cur = target.getItem(slot);
        if (!cur || !cur.isStackableWith(item)) continue;
        const n = Math.min(cur.amount, left);
        if (n === cur.amount) target.setItem(slot, undefined);
        else {
            cur.amount -= n;
            target.setItem(slot, cur);
        }
        left -= n;
    }
    return left === 0;
}

function processSortNode(block) {
    if (!block?.isValid || block.typeId !== SORT_NODE_BLOCK) return 0;
    const inputs = getSortNodeInputDirections(block);
    if (inputs.length === 0) return 0;
    for (const inputSide of inputs) {
        const source = getSortContainerOnSide(block, inputSide);
        if (!source) continue;
        for (let slot = 0; slot < source.size; slot++) {
            const item = source.getItem(slot);
            if (!item) continue;
            const route = evaluateSortNodeFilter(block, item);
            const outputSides = getSortNodeOutputDirections(block, route.filterOutput);
            for (const side of outputSides) {
                const target = getSortContainerOnSide(block, side);
                if (!target || target === source) continue;
                const amount = Math.min(
                    item.amount,
                    SORT_TRANSFER_LIMIT,
                    previewAcceptedAmount(target, item, SORT_TRANSFER_LIMIT),
                );
                if (amount <= 0) continue;
                const inserted = insertExact(target, item, amount);
                if (inserted <= 0) continue;
                if (!removeExact(source, slot, item, inserted)) {
                    rollbackExact(target, item, inserted);
                    continue;
                }
                return inserted;
            }
        }
    }
    return 0;
}

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    if (ev.block?.typeId === SORT_NODE_BLOCK) rememberSortNode(ev.block);
});
world.afterEvents.playerBreakBlock.subscribe((ev) => {
    const id = ev.brokenBlockPermutation?.type?.id ?? ev.brokenBlockPermutation?.typeId;
    if (id === SORT_NODE_BLOCK)
        activeSortNodes.delete(
            `${ev.dimension.id}:${ev.block.location.x},${ev.block.location.y},${ev.block.location.z}`,
        );
});
system.runInterval(() => {
    for (const [key, loc] of activeSortNodes) {
        let block = null;
        try {
            block = world.getDimension(loc.d).getBlock(loc);
        } catch {}
        if (!block || block.typeId !== SORT_NODE_BLOCK) {
            activeSortNodes.delete(key);
            continue;
        }
        processSortNode(block);
    }
}, SORT_TRANSFER_INTERVAL);

export function receiveSortNodeItem(block, incomingSide, itemStack, maxItems = 4) {
    if (!block?.isValid || block.typeId !== SORT_NODE_BLOCK || !itemStack) return 0;
    rememberSortNode(block);
    if (!getSortNodeInputDirections(block).includes(incomingSide)) return 0;
    const route = evaluateSortNodeFilter(block, itemStack);
    for (const outSide of getSortNodeOutputDirections(block, route.filterOutput)) {
        const target = getSortContainerOnSide(block, outSide);
        if (!target) continue;
        const amount = Math.min(
            itemStack.amount,
            maxItems,
            previewAcceptedAmount(target, itemStack, maxItems),
        );
        if (amount <= 0) continue;
        return insertExact(target, itemStack, amount);
    }
    return 0;
}
