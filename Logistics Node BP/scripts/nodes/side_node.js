import { world, system } from "@minecraft/server";
import { receiveSortNodeItem } from "./sort_node.js";
import { getTrashBuffer } from "./trash_node.js";
const SORT_NODE_BLOCK = "vfh:sort_node";

import {
    ADJACENT_DIRECTIONS,
    getAdjacentContainers,
    getBlockContainer,
    getRoundRobinTargets,
    advanceRoundRobin,
} from "../core/container.js";

import { findMarkerAtBlock, ensureMarkerForBlock, dropEntityInventory } from "../core/marker.js";

import { moveBlockToEntity, moveContainerItems, canTransferToTarget } from "../core/transfer.js";

import { SIDE_NODE_ENTITY, SIDE_NODE_BLOCK, TRASH_NODE_BLOCK, DIMENSION_IDS } from "../config/constants.js";

import { ModalFormData } from "@minecraft/server-ui";

import {
    ALL_DIRECTIONS,
    getNodeInputFaces,
    getNodeOutputFaces,
    canNodeConnectToNode,
} from "../core/node_direction.js";

const DEFAULT_SPEED = 64;

function getFacing(block) {
    try {
        return block.permutation.getState("minecraft:cardinal_direction") ?? null;
    } catch {
        return null;
    }
}

function getAdjacentBlock(block, directionName) {
    const direction = ADJACENT_DIRECTIONS.find((value) => value.name === directionName);
    if (!direction) return null;
    try {
        return block.dimension.getBlock({
            x: block.location.x + direction.x,
            y: block.location.y + direction.y,
            z: block.location.z + direction.z,
        });
    } catch {
        return null;
    }
}

function spawnMarker(block) {
    const marker = ensureMarkerForBlock(block, SIDE_NODE_ENTITY, null, SIDE_NODE_BLOCK);
    if (!marker) return null;
    if (marker.getDynamicProperty("fast_hopper_speed") === undefined)
        marker.setDynamicProperty("fast_hopper_speed", DEFAULT_SPEED);
    const initialInput = getSideInputSetting(marker, block);
    if (marker.getDynamicProperty("side_input_direction") === undefined)
        marker.setDynamicProperty("side_input_direction", initialInput);
    syncSideJointVisual(block, getSideInputSetting(marker, block));
    return marker;
}

/* =========================================================
   REMOVE SIDE NODE MARKER ON PLAYER BREAK
========================================================= */
world.afterEvents.playerBreakBlock.subscribe((event) => {
    let brokenTypeId;
    try {
        brokenTypeId = event.brokenBlockPermutation.type.id;
    } catch {
        return;
    }
    if (brokenTypeId !== SIDE_NODE_BLOCK) return;

    const marker = findMarkerAtBlock(event.block, SIDE_NODE_ENTITY);
    if (!marker) return;
    try {
        dropEntityInventory(marker);
    } finally {
        try {
            marker.remove();
        } catch {}
    }
});

/* SIDE S2-A V3 */
const SIDE_INPUT_DIRECTIONS = Object.freeze(["north", "south", "east", "west", "up", "down"]);
/* SIDE S2-A V4 I18N */
const SIDE_INPUT_LABELS = Object.freeze([
    { translate: "vfh.ui.face.north" },
    { translate: "vfh.ui.face.south" },
    { translate: "vfh.ui.face.east" },
    { translate: "vfh.ui.face.west" },
    { translate: "vfh.ui.face.up" },
    { translate: "vfh.ui.face.down" },
]);
function getSideInputSetting(marker, block) {
    const saved = marker?.getDynamicProperty("side_input_direction");
    if (SIDE_INPUT_DIRECTIONS.includes(saved)) return saved;
    const legacy = getFacing(block);
    return SIDE_INPUT_DIRECTIONS.includes(legacy) ? legacy : "north";
}
/* SIDE S2-B JOINT VISUAL */
const SIDE_INPUT_VISUAL_STATE = "vfh:side_input_visual";
function syncSideJointVisual(block, direction) {
    if (!block || block.typeId !== SIDE_NODE_BLOCK) return false;
    if (!SIDE_INPUT_DIRECTIONS.includes(direction)) return false;
    try {
        const current = block.permutation.getState(SIDE_INPUT_VISUAL_STATE);
        if (current === direction) return true;
        block.setPermutation(block.permutation.withState(SIDE_INPUT_VISUAL_STATE, direction));
        return true;
    } catch (error) {
        return false;
    }
}

const openingSideForm = new Set();
/* =========================================================
   OPEN SIDE NODE SETTINGS
========================================================= */
world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const player = event.player;
    if (!player.isSneaking || event.block.typeId !== SIDE_NODE_BLOCK || event.itemStack) {
        return;
    }

    event.cancel = true;
    const dimension = event.block.dimension;
    const location = {
        x: event.block.location.x,
        y: event.block.location.y,
        z: event.block.location.z,
    };
    const key = `${player.id}:${location.x}:${location.y}:${location.z}`;
    if (openingSideForm.has(key)) return;
    openingSideForm.add(key);

    system.run(() => {
        try {
            const block = dimension.getBlock(location);
            if (!block || block.typeId !== SIDE_NODE_BLOCK) {
                openingSideForm.delete(key);
                return;
            }

            const marker = spawnMarker(block);
            if (!marker) {
                openingSideForm.delete(key);
                return;
            }

            const speed = Number(marker.getDynamicProperty("fast_hopper_speed")) || DEFAULT_SPEED;
            const input = getSideInputSetting(marker, block);
            new ModalFormData()
                .title({ translate: "vfh.ui.side.title" })
                .slider({ translate: "vfh.ui.side.transfer_speed" }, 1, 256, {
                    defaultValue: speed,
                })
                .dropdown({ translate: "vfh.ui.side.input_direction" }, SIDE_INPUT_LABELS, {
                    defaultValueIndex: SIDE_INPUT_DIRECTIONS.indexOf(input),
                })
                .submitButton({ translate: "vfh.ui.common.save" })
                .show(player)
                .then((r) => {
                    if (r.canceled || !Array.isArray(r.formValues)) return;
                    const newSpeed = Number(r.formValues[0]);
                    const newInput = SIDE_INPUT_DIRECTIONS[Number(r.formValues[1])];
                    if (!Number.isFinite(newSpeed) || !newInput) return;
                    marker.setDynamicProperty("fast_hopper_speed", newSpeed);
                    marker.setDynamicProperty("side_input_direction", newInput);
                    syncSideJointVisual(block, newInput);
                    player.sendMessage(`Side Node saved: Speed=${newSpeed}, Input=${newInput}`);
                })
                .catch(() => {})
                .finally(() => openingSideForm.delete(key));
        } catch (error) {
            openingSideForm.delete(key);
        }
    });
});
world.afterEvents.playerPlaceBlock.subscribe((event) => {
    if (event.block.typeId !== SIDE_NODE_BLOCK) return;
    const marker = spawnMarker(event.block);
    const inputDirection = getSideInputSetting(marker, event.block);
    syncSideJointVisual(event.block, inputDirection);
});

function hasBufferedSideItem(marker) {
    const inventory = marker?.getComponent("minecraft:inventory")?.container;
    if (!inventory) return false;

    for (let slot = 0; slot < inventory.size; slot++) {
        if (inventory.getItem(slot)) return true;
    }

    return false;
}

export function processSideNode(marker) {
    const speed = Number(marker.getDynamicProperty("fast_hopper_speed")) || DEFAULT_SPEED;
    const dimension = marker.dimension;
    const pos = {
        x: Math.floor(marker.location.x),
        y: Math.floor(marker.location.y),
        z: Math.floor(marker.location.z),
    };
    let sideNode;
    try {
        sideNode = dimension.getBlock(pos);
    } catch {
        return;
    }
    if (!sideNode || sideNode.typeId !== SIDE_NODE_BLOCK) {
        // Chunk reload can expose the marker entity before the owner block is
        // fully readable. Never destructively clean up from the hot path.
        // Real block breaks are handled immediately by playerBreakBlock, while
        // marker_lifecycle.js performs delayed orphan confirmation.
        return;
    }

    const facing = getFacing(sideNode);
    /* SIDE S2-A V4 TRANSFER */
    /* SIDE UNIFY MIGRATE */
    const savedInput = marker.getDynamicProperty("side_input_direction");
    const inputDirection = getSideInputSetting(marker, sideNode);
    syncSideJointVisual(sideNode, inputDirection);
    if (!inputDirection) {
        return;
    }

    const inputBlock = getAdjacentBlock(sideNode, inputDirection);
    const inputMoved = inputBlock ? moveBlockToEntity(inputBlock, marker, speed) : 0;

    // P3-B2 Empty Fast Path:
    // INPUT is processed first so newly received items remain eligible for output
    // in the same Side Node cycle. Only skip OUTPUT resolution when the Side
    // buffer is still empty after INPUT processing.
    if (!hasBufferedSideItem(marker)) {
        return;
    }

    const outputFaces = getNodeOutputFaces(sideNode);
    const excludedOutputFaces = ALL_DIRECTIONS.filter(
        (direction) => !outputFaces.includes(direction),
    );
    const adjacentTargets = getAdjacentContainers(
        sideNode,
        getBlockContainer,
        excludedOutputFaces,
        marker,
    );
    const targets = adjacentTargets.filter((target) => {
        const allowed = canTransferToTarget(SIDE_NODE_ENTITY, target, sideNode);
        return allowed;
    });

    const source = marker.getComponent("minecraft:inventory")?.container;
    if (!source) return;

    // TR-3: Trash Node exposes a normal temporary inventory buffer.
    for (const direction of outputFaces) {
        const targetBlock = getAdjacentBlock(sideNode, direction);
        if (targetBlock?.typeId !== TRASH_NODE_BLOCK) continue;
        // TR-3A: Trash Node is a terminal sink and has no configurable INPUT face.
        // Side Node outputFaces already guarantees that this is an OUTPUT face,
        // so do not route Trash through canNodeConnectToNode(), which requires
        // the target node to expose an INPUT face.
        const target = getTrashBuffer(targetBlock);
        if (!target) continue;
        if (moveContainerItems(source, target, speed) > 0) return;
    }

    // First-class Side -> Sort Node path. Sort Node has no persistent entity/inventory,
    // so it receives directly through its configured INPUT face and commits to an output container.
    for (const direction of outputFaces) {
        const targetBlock = getAdjacentBlock(sideNode, direction);
        if (targetBlock?.typeId !== SORT_NODE_BLOCK) continue;
        if (!canNodeConnectToNode(sideNode, direction, targetBlock)) continue;
        const opposite = {
            north: "south",
            south: "north",
            east: "west",
            west: "east",
            up: "down",
            down: "up",
        }[direction];
        for (let slot = 0; slot < source.size; slot++) {
            const item = source.getItem(slot);
            if (!item) continue;
            const moved = receiveSortNodeItem(
                targetBlock,
                opposite,
                item,
                Math.min(speed, item.amount),
            );
            if (moved <= 0) continue;
            const current = source.getItem(slot);
            if (!current || !current.isStackableWith(item) || current.amount < moved) return;
            if (current.amount === moved) source.setItem(slot, undefined);
            else {
                current.amount -= moved;
                source.setItem(slot, current);
            }
            return;
        }
    }
    if (targets.length === 0) return;

    const orderedTargets = getRoundRobinTargets(marker, targets);
    for (const target of orderedTargets) {
        const moved = moveContainerItems(source, target.container, speed);
        if (moved <= 0) continue;
        advanceRoundRobin(marker, targets, target);
        break;
    }
}

system.runInterval(() => {
    for (const dimId of DIMENSION_IDS) {
        const dimension = world.getDimension(dimId);
        const markers = dimension.getEntities({ type: SIDE_NODE_ENTITY });
        for (const marker of markers) processSideNode(marker);
    }
}, 20);
