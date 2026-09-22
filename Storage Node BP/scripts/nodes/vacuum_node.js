import {
    world,
    system
} from "@minecraft/server";

import {
    ModalFormData
} from "@minecraft/server-ui";

import {
    findMarkerAtBlock
} from "../core/marker.js";

import {
    moveEntityToAdjacentBlocks
} from "../core/transfer.js";

import {
    VACUUM_NODE_ENTITY,
    VACUUM_NODE_BLOCK,
    DIMENSION_IDS
} from "../config/constants.js";
import {
    getNodeOutputFaces
} from "../core/node_direction.js";

const openingVacuumForm = new Set();

/* =========================================================
   OPEN VACUUM SETTINGS
========================================================= */

world.beforeEvents.playerInteractWithBlock.subscribe(ev => {

    const player = ev.player;

    if (!player.isSneaking) {
        return;
    }

    if (
        ev.block.typeId !==
        VACUUM_NODE_BLOCK
    ) {
        return;
    }

    if (ev.itemStack)
        return;

    const vacuum =
        findMarkerAtBlock(
            ev.block,
            VACUUM_NODE_ENTITY
        );

    if (!vacuum) {
        return;
    }

    ev.cancel = true;

    const formKey =
        `${player.id}:${ev.block.location.x}:${ev.block.location.y}:${ev.block.location.z}`;

    if (
        openingVacuumForm.has(
            formKey
        )
    ) {
        return;
    }

    openingVacuumForm.add(
        formKey
    );

    system.run(() => {

        const range =
            Number(
                vacuum.getDynamicProperty(
                    "vacuum_hopper_range"
                )
            ) || 5;

        const form =
            new ModalFormData()
                .title(
                    "Vacuum Node"
                )
                .slider(
                    "Pickup Range",
                    1,
                    10,
                    {
                        defaultValue:
                            range
                    }
                );

        form.show(player)
            .then(result => {

                if (
                    result.canceled
                ) {
                    return;
                }

                const value =
                    Number(
                        result.formValues[0]
                    );

                vacuum.setDynamicProperty(
                    "vacuum_hopper_range",
                    value
                );

                player.sendMessage(
                    `§bRange = ${value}`
                );

            })
            .catch(error => {

                console.warn(
                    "FORM ERROR = " +
                    error
                );

            })
            .finally(() => {

                openingVacuumForm.delete(
                    formKey
                );
            });
    });
});

/* =========================================================
   PLACE VACUUM NODE
========================================================= */

world.afterEvents.playerPlaceBlock.subscribe(ev => {

    const block = ev.block;

    if (
        block.typeId ===
        VACUUM_NODE_BLOCK
    ) {

        if (
            findMarkerAtBlock(
                block,
                VACUUM_NODE_ENTITY
            )
        ) {
            return;
        }

        const marker =
            block.dimension.spawnEntity(
                VACUUM_NODE_ENTITY,
                {
                    x: block.location.x + 0.5,
                    y: block.location.y + 0.5,
                    z: block.location.z + 0.5
                }
            );

        marker.setDynamicProperty(
            "vacuum_hopper_range",
            5
        );
    }
});

/* =========================================================
   VACUUM HOPPER ENGINE
========================================================= */

system.runInterval(() => {
    for (const dimId of DIMENSION_IDS) {

        const dimension =
            world.getDimension(dimId);

        const vacuums =
            dimension.getEntities({
                type:
                    VACUUM_NODE_ENTITY
            });

        for (const marker of vacuums) {

            processVacuumHopper(
                marker
            );
        }
    }

}, 5);


/* =========================================================
   PROCESS VACUUM NODE
========================================================= */

export function processVacuumHopper(
    marker
) {

    const range =
        Number(
            marker.getDynamicProperty(
                "vacuum_hopper_range"
            )
        ) || 5;

    const dimension =
        marker.dimension;

    const pos = {

        x:
            Math.floor(
                marker.location.x
            ),

        y:
            Math.floor(
                marker.location.y
            ),

        z:
            Math.floor(
                marker.location.z
            )
    };

    const hopper =
        dimension.getBlock(pos);

    if (
        !hopper ||
        hopper.typeId !==
        VACUUM_NODE_BLOCK
    ) {

        /* marker.remove(); */
        return;
    }

    suckItems(
        marker,
        range
    );

    const outputFaces =
        getNodeOutputFaces(hopper);

    moveEntityToAdjacentBlocks(
        marker,
        hopper,
        64,
        !outputFaces.includes("up")
    );
}


/* =========================================================
   SUCK ITEMS
========================================================= */

export function suckItems(
    marker,
    range
) {

    const inventory =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    if (!inventory)
        return;

    const items =
        marker.dimension
        .getEntities({

            type:
                "minecraft:item",

            location: {

                x:
                    marker.location.x
                    + 0.5,

                y:
                    marker.location.y
                    + 0.5,

                z:
                    marker.location.z
                    + 0.5
            },

            maxDistance:
                range
        })
        .slice(0, 16);

    for (const itemEntity of items) {

        try {

            const itemComp =
                itemEntity.getComponent(
                    "minecraft:item"
                );

            if (!itemComp)
                continue;

            const leftover =
                inventory.addItem(
                    itemComp.itemStack
                );

            if (!leftover) {

                itemEntity.remove();
            }

        } catch {}
    }
}