import { world, system } from "@minecraft/server";

import { ModalFormData } from "@minecraft/server-ui";

import { findMarkerAtBlock, ensureMarkerForBlock, dropEntityInventory } from "../core/marker.js";

import { moveEntityToAdjacentBlocks } from "../core/transfer.js";

import { VACUUM_NODE_ENTITY, VACUUM_NODE_BLOCK, DIMENSION_IDS } from "../config/constants.js";
import { getNodeOutputFaces } from "../core/node_direction.js";

const openingVacuumForm = new Set();
function initializeVacuumMarker(marker) {
    if (!marker) return null;
    if (marker.getDynamicProperty("vacuum_hopper_range") === undefined)
        marker.setDynamicProperty("vacuum_hopper_range", 5);
    return marker;
}
function ensureVacuumMarker(block) {
    return initializeVacuumMarker(
        ensureMarkerForBlock(block, VACUUM_NODE_ENTITY, null, VACUUM_NODE_BLOCK),
    );
}

/* =========================================================
   OPEN VACUUM SETTINGS
========================================================= */

world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
    const player = ev.player;
    if (!player.isSneaking || ev.block.typeId !== VACUUM_NODE_BLOCK || ev.itemStack) return;
    ev.cancel = true;
    const dimension = ev.block.dimension;
    const location = { x: ev.block.location.x, y: ev.block.location.y, z: ev.block.location.z };
    const formKey = `${player.id}:${dimension.id}:${location.x}:${location.y}:${location.z}`;
    if (openingVacuumForm.has(formKey)) return;
    openingVacuumForm.add(formKey);
    system.run(() => {
        try {
            const block = dimension.getBlock(location);
            if (!block || block.typeId !== VACUUM_NODE_BLOCK) {
                openingVacuumForm.delete(formKey);
                return;
            }
            const vacuum = ensureVacuumMarker(block);
            if (!vacuum) {
                openingVacuumForm.delete(formKey);
                return;
            }
            const range = Number(vacuum.getDynamicProperty("vacuum_hopper_range")) || 5;
            const form = new ModalFormData()
                .title("Vacuum Node")
                .slider("Pickup Range", 1, 10, { defaultValue: range });
            form.show(player)
                .then((result) => {
                    if (result.canceled || !Array.isArray(result.formValues)) return;
                    const value = Number(result.formValues[0]);
                    vacuum.setDynamicProperty("vacuum_hopper_range", value);
                    player.sendMessage(`Range = ${value}`);
                })
                .catch((error) => (() => {})("FORM ERROR = " + error))
                .finally(() => openingVacuumForm.delete(formKey));
        } catch (error) {
            (() => {})("VACUUM SELF-HEAL ERROR = " + error);
            openingVacuumForm.delete(formKey);
        }
    });
});

/* =========================================================
   PLACE VACUUM NODE
========================================================= */

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    const block = ev.block;

    if (block.typeId === VACUUM_NODE_BLOCK) {
        if (findMarkerAtBlock(block, VACUUM_NODE_ENTITY)) {
            return;
        }

        const marker = block.dimension.spawnEntity(VACUUM_NODE_ENTITY, {
            x: block.location.x + 0.5,
            y: block.location.y + 0.5,
            z: block.location.z + 0.5,
        });

        marker.setDynamicProperty("vacuum_hopper_range", 5);
    }
});

/* =========================================================
   VACUUM HOPPER ENGINE
========================================================= */

system.runInterval(() => {
    for (const dimId of DIMENSION_IDS) {
        const dimension = world.getDimension(dimId);

        const vacuums = dimension.getEntities({
            type: VACUUM_NODE_ENTITY,
        });

        for (const marker of vacuums) {
            processVacuumHopper(marker);
        }
    }
}, 5);

/* =========================================================
   PROCESS VACUUM NODE
========================================================= */

export function processVacuumHopper(marker) {
    const range = Number(marker.getDynamicProperty("vacuum_hopper_range")) || 5;

    const dimension = marker.dimension;

    const pos = {
        x: Math.floor(marker.location.x),

        y: Math.floor(marker.location.y),

        z: Math.floor(marker.location.z),
    };

    const hopper = dimension.getBlock(pos);

    if (!hopper || hopper.typeId !== VACUUM_NODE_BLOCK) {
        /* Orphan cleanup: preserve buffered items before removing the marker. */
        try {
            dropEntityInventory(marker);
        } finally {
            try {
                marker.remove();
            } catch {}
        }
        return;
    }

    suckItems(marker, range);

    // P3-B1 Empty Fast Path:
    // Avoid adjacent block/container resolution and transfer slot scans when the
    // Vacuum Node buffer has no item to output. The inventory has 27 slots, so
    // this bounded check is substantially cheaper than attempting up to six
    // adjacent transfers, each of which may scan the same empty source again.
    if (!hasBufferedVacuumItem(marker)) {
        return;
    }

    const outputFaces = getNodeOutputFaces(hopper);

    moveEntityToAdjacentBlocks(marker, hopper, 64, !outputFaces.includes("up"));
}

/* =========================================================
   VACUUM BUFFER FAST CHECK
========================================================= */

function hasBufferedVacuumItem(marker) {
    const inventory = marker?.getComponent("minecraft:inventory")?.container;

    if (!inventory) {
        return false;
    }

    for (let slot = 0; slot < inventory.size; slot++) {
        if (inventory.getItem(slot)) {
            return true;
        }
    }

    return false;
}

/* =========================================================
   SUCK ITEMS
========================================================= */

export function suckItems(marker, range) {
    const inventory = marker.getComponent("minecraft:inventory")?.container;

    if (!inventory) return;

    const items = marker.dimension
        .getEntities({
            type: "minecraft:item",

            location: {
                x: marker.location.x + 0.5,

                y: marker.location.y + 0.5,

                z: marker.location.z + 0.5,
            },

            maxDistance: range,
        })
        .slice(0, 16);

    for (const itemEntity of items) {
        try {
            const itemComp = itemEntity.getComponent("minecraft:item");

            if (!itemComp) continue;

            const leftover = inventory.addItem(itemComp.itemStack);

            if (!leftover) {
                itemEntity.remove();
            }
        } catch {}
    }
}
