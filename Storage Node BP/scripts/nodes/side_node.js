import { world, system } from "@minecraft/server";

import {
    ADJACENT_DIRECTIONS,
    getAdjacentContainers,
    getBlockContainer,
    getRoundRobinTargets,
    advanceRoundRobin
} from "../core/container.js";

import {
    findMarkerAtBlock,
    dropEntityInventory
} from "../core/marker.js";

import {
    moveBlockToEntity,
    moveContainerItems,
    canTransferToTarget
} from "../core/transfer.js";

import {
    SIDE_NODE_ENTITY,
    SIDE_NODE_BLOCK,
    DIMENSION_IDS
} from "../config/constants.js";

import {
    ModalFormData
} from "@minecraft/server-ui";

import {
    ALL_DIRECTIONS,
    getNodeInputFaces,
    getNodeOutputFaces
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
    const direction = ADJACENT_DIRECTIONS.find(value => value.name === directionName);
    if (!direction) return null;
    try {
        return block.dimension.getBlock({
            x: block.location.x + direction.x,
            y: block.location.y + direction.y,
            z: block.location.z + direction.z
        });
    } catch {
        return null;
    }
}

function spawnMarker(block) {
    const existing = findMarkerAtBlock(block, SIDE_NODE_ENTITY);
    if (existing) return existing;
    const marker = block.dimension.spawnEntity(SIDE_NODE_ENTITY, {
        x: block.location.x + 0.5,
        y: block.location.y + 0.5,
        z: block.location.z + 0.5
    });
    marker.setDynamicProperty("fast_hopper_speed", DEFAULT_SPEED);
    /* SIDE UNIFY INIT */
    const initialInput = getSideInputSetting(marker, block);
    marker.setDynamicProperty("side_input_direction", initialInput);
    syncSideJointVisual(block, initialInput);
    return marker;

}


/* =========================================================
   REMOVE SIDE NODE MARKER ON PLAYER BREAK
========================================================= */
world.afterEvents.playerBreakBlock.subscribe(event => {
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
const SIDE_INPUT_DIRECTIONS = Object.freeze(["north","south","east","west","up","down"]);
/* SIDE S2-A V4 I18N */
const SIDE_INPUT_LABELS = Object.freeze([
    { translate: "vfh.ui.face.north" },
    { translate: "vfh.ui.face.south" },
    { translate: "vfh.ui.face.east" },
    { translate: "vfh.ui.face.west" },
    { translate: "vfh.ui.face.up" },
    { translate: "vfh.ui.face.down" }
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
world.beforeEvents.playerInteractWithBlock.subscribe(event => {
    const player = event.player;
    if (!player.isSneaking || event.block.typeId !== SIDE_NODE_BLOCK || event.itemStack) return;
    const marker = findMarkerAtBlock(event.block, SIDE_NODE_ENTITY);
    if (!marker) return;
    event.cancel = true;
    const key = `${player.id}:${event.block.location.x}:${event.block.location.y}:${event.block.location.z}`;
    if (openingSideForm.has(key)) return;
    openingSideForm.add(key);
    system.run(() => {
        const speed = Number(marker.getDynamicProperty("fast_hopper_speed")) || DEFAULT_SPEED;
        const input = getSideInputSetting(marker, event.block);
        new ModalFormData()
            .title({ translate: "vfh.ui.side.title" })
            .slider({ translate: "vfh.ui.side.transfer_speed" }, 1, 256, { defaultValue: speed })
            .dropdown({ translate: "vfh.ui.side.input_direction" }, SIDE_INPUT_LABELS, { defaultValueIndex: SIDE_INPUT_DIRECTIONS.indexOf(input) })
            .submitButton({ translate: "vfh.ui.common.save" })
            .show(player)
            .then(r => {
                if (r.canceled || !Array.isArray(r.formValues)) return;
                const newSpeed = Number(r.formValues[0]);
                const newInput = SIDE_INPUT_DIRECTIONS[Number(r.formValues[1])];
                if (!Number.isFinite(newSpeed) || !newInput) return;
                marker.setDynamicProperty("fast_hopper_speed", newSpeed);
                marker.setDynamicProperty("side_input_direction", newInput);
                syncSideJointVisual(event.block, newInput);
                player.sendMessage(`§aSide Node saved: Speed=${newSpeed}, Input=${newInput}`);
            })
            .catch(e => console.warn("SIDE FORM ERROR = " + e))
            .finally(() => openingSideForm.delete(key));
    });
});

world.afterEvents.playerPlaceBlock.subscribe(event => {
    if (event.block.typeId !== SIDE_NODE_BLOCK) return;
    const marker = spawnMarker(event.block);
    const inputDirection = getSideInputSetting(marker, event.block);
    syncSideJointVisual(event.block, inputDirection);
});

export function processSideNode(marker) {
    const speed = Number(marker.getDynamicProperty("fast_hopper_speed")) || DEFAULT_SPEED;
    const dimension = marker.dimension;
    const pos = {
        x: Math.floor(marker.location.x),
        y: Math.floor(marker.location.y),
        z: Math.floor(marker.location.z)
    };
    let sideNode;
    try {
        sideNode = dimension.getBlock(pos);
    } catch {
        return;
    }
    if (!sideNode || sideNode.typeId !== SIDE_NODE_BLOCK) {
            /*
             * Orphan cleanup. The block no longer exists, so the marker must not
             * remain in the world. Preserve buffered items before removal.
             */
            try {
                dropEntityInventory(marker);
            } finally {
                try {
                    marker.remove();
                } catch {}
            }
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

    const outputFaces = getNodeOutputFaces(sideNode);
    const excludedOutputFaces = ALL_DIRECTIONS.filter(
        direction => !outputFaces.includes(direction)
    );
    const adjacentTargets = getAdjacentContainers(
        sideNode,
        getBlockContainer,
        excludedOutputFaces,
        marker
    );
    const targets = adjacentTargets.filter(target => {
        const allowed = canTransferToTarget(SIDE_NODE_ENTITY, target, sideNode);
        return allowed;
    });

    const source = marker.getComponent("minecraft:inventory")?.container;
    if (!source || targets.length === 0) return;

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
