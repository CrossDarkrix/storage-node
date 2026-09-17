import {
    world,
    system,
} from "@minecraft/server";

import {
    ModalFormData
} from "@minecraft/server-ui";


const FAST_HOPPER_ENTITY =
    "entity:storage_node";

const VACUUM_HOPPER_ENTITY =
    "entity:vacuum_node";

const openingStorageForm = new Set();
const openingVacuumForm = new Set();

const CONTAINERS = [
    "minecraft:chest",
    "minecraft:barrel",
    "minecraft:dispenser",
    "minecraft:dropper",
    "minecraft:hopper",
    "minecraft:trapped_chest",
    "minecraft:furnace",
    "minecraft:smoker"
];

function isContainer(block) {

    if (!block)
        return false;

    return (
        CONTAINERS.includes(
            block.typeId
        ) ||
        block.typeId.endsWith(
            "_shulker_box"
        )
    );
}

function findMarkerAtBlock(
    block,
    entityType
) {

    return block.dimension
        .getEntities({
            type: entityType
        })
        .find(entity =>
            Math.floor(entity.location.x) === block.location.x &&
            Math.floor(entity.location.y) === block.location.y &&
            Math.floor(entity.location.z) === block.location.z
        );

}

/* =========================================================
   PLACE STORAGE NODE
========================================================= */

world.afterEvents.playerPlaceBlock.subscribe(ev => {

    const block = ev.block;

    if (
        block.typeId ===
        "vfh:storage_node"
    ) {

        if (
            findMarkerAtBlock(
                block,
                FAST_HOPPER_ENTITY
            )
        ) {
            return;
        }

        const marker =
            block.dimension.spawnEntity(
                FAST_HOPPER_ENTITY,
                {
                    x: block.location.x + 0.5,
                    y: block.location.y + 0.5,
                    z: block.location.z + 0.5
                }
            );
        marker.setDynamicProperty(
            "fast_hopper_speed",
            64
        );
    }

});

/* =========================================================
   PLACE VACUUM NODE
========================================================= */

world.afterEvents.playerPlaceBlock.subscribe(ev => {

    const block = ev.block;

    if (
        block.typeId ===
        "vfh:vacuum_node"
    ) {

        if (
            findMarkerAtBlock(
                block,
                VACUUM_HOPPER_ENTITY
            )
        ) {
            return;
        }

            const marker =
        block.dimension.spawnEntity(
            VACUUM_HOPPER_ENTITY,
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
   OPEN SETTINGS
========================================================= */

world.beforeEvents.playerInteractWithBlock.subscribe(ev => {

    const player = ev.player;

    if (!player.isSneaking)
        return;

    if (ev.block.typeId !== "vfh:storage_node") {
        return;
    }

    if (ev.itemStack)
        return;

    const hopper = findMarkerAtBlock(ev.block, FAST_HOPPER_ENTITY);

    if (!hopper)
        return;

    ev.cancel = true;
    const formKey = `${player.id}:${ev.block.location.x}:${ev.block.location.y}:${ev.block.location.z}`;

    if (openingStorageForm.has(formKey)) {
        return;
    }

    openingStorageForm.add(formKey);

    system.run(() => {

    const speed =
        Number(
            hopper.getDynamicProperty(
                "fast_hopper_speed"
            )
        ) || 64;

    const form =
        new ModalFormData()
            .title("Storage Node")
            .slider(
                "Transfer Amount",
                1,
                256,
                {
                    defaultValue: speed
                }
            );

    form.show(player)
        .then(result => {
            if (result.canceled) {
                return;
            }

            const value =
                Number(
                    result.formValues[0]
                );

            hopper.setDynamicProperty(
                "fast_hopper_speed",
                value
            );

            player.sendMessage(
                `§aSpeed = ${value}`
            );

        })
        .catch(error => {

            console.warn(
                "STORAGE FORM ERROR = " +
                error
            );

        })
        .finally(() => {
            openingStorageForm.delete(
                formKey
            );
        });
    });
});

world.beforeEvents.playerInteractWithBlock.subscribe(ev => {

    const player = ev.player;

    if (!player.isSneaking) {
        return;
    }

    if (ev.block.typeId !== "vfh:vacuum_node") {
        return;
    }
    if (ev.itemStack)
        return;

    const vacuum = findMarkerAtBlock(ev.block, VACUUM_HOPPER_ENTITY);

    if (!vacuum) {
        return;
    }

    ev.cancel = true;

    const formKey = `${player.id}:${ev.block.location.x}:${ev.block.location.y}:${ev.block.location.z}`;

    if (openingVacuumForm.has(formKey)) {
        return;
    }

    openingVacuumForm.add(formKey);

    system.run(() => {
        const range =
            Number(
                vacuum.getDynamicProperty(
                    "vacuum_hopper_range"
                )
            ) || 5;
        const form =
            new ModalFormData()
                .title("Vacuum Node")
                .slider(
                    "Pickup Range",
                    1,
                    10,
                    {
                        defaultValue: range
                    }
                );
        form.show(player)
            .then(result => {
                if (result.canceled) {
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
                openingVacuumForm.delete(formKey);
            });
    });

});

/* =========================================================
   REMOVE MARKER
========================================================= */

world.afterEvents.playerBreakBlock.subscribe(
    ev => {

        for (
            const type of [
                FAST_HOPPER_ENTITY,
                VACUUM_HOPPER_ENTITY
            ]
        ) {

            const marker =
                findMarkerAtBlock(
                    ev.block,
                    type
                );

            if (marker) {
                marker.remove();
            }

        }

    }
);

/* =========================================================
   FAST HOPPER ENGINE
========================================================= */

system.runInterval(() => {

    const dimensions = [
        "minecraft:overworld",
        "minecraft:nether",
        "minecraft:the_end"
    ];

    for (const dimId of dimensions) {

        const dimension =
            world.getDimension(dimId);

        const hoppers =
            dimension.getEntities({
                type: FAST_HOPPER_ENTITY
            });

        for (const marker of hoppers) {
            processFastHopper(marker);
        }
    }

}, 20);

/* =========================================================
   VACUUM HOPPER ENGINE
========================================================= */

system.runInterval(() => {

    const dimensions = [
        "minecraft:overworld",
        "minecraft:nether",
        "minecraft:the_end"
    ];

    for (const dimId of dimensions) {

        const dimension =
            world.getDimension(dimId);

        const vacuums =
            dimension.getEntities({
                type:
                VACUUM_HOPPER_ENTITY
            });

        for (const marker of vacuums) {

            processVacuumHopper(
                marker
            );
        }
    }

}, 5);

/* =========================================================
   PROCESS
========================================================= */

function processFastHopper(
    marker
) {

    const speed =
        Number(
            marker.getDynamicProperty(
                "fast_hopper_speed"
            )
        ) || 64;

    const dimension =
        marker.dimension;

    const pos = {

        x: Math.floor(
            marker.location.x
        ),

        y: Math.floor(
            marker.location.y
        ),

        z: Math.floor(
            marker.location.z
        )
    };

    const hopper =
        dimension.getBlock(pos);

    if (
        !hopper ||
        hopper.typeId !==
        "vfh:storage_node"
    ) {

        /* marker.remove(); */
        return;
    }

    const topBlock =
        dimension.getBlock({
            x: pos.x,
            y: pos.y + 1,
            z: pos.z
        });

    moveBlockToEntity(
        topBlock,
        marker,
        speed
    );

    moveEntityToAdjacentBlocks(
        marker,
        hopper,
        speed,
        true
    );
}

function processVacuumHopper(
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
        "vfh:vacuum_node"
    ) {

        /* marker.remove(); */
        return;
    }

    suckItems(
        marker,
        range
    );

    moveEntityToAdjacentBlocks(
        marker,
        hopper,
        64,
        false
    );
}

function suckItems(
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

function moveBlockToEntity(
    sourceBlock,
    marker,
    maxItems
) {

    if (!sourceBlock)
        return;

    if (!isContainer(sourceBlock))
        return;

    const source =
        sourceBlock.getComponent(
            "inventory"
        )?.container;

    const target =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    if (!source || !target)
        return;

    moveContainerItems(
        source,
        target,
        maxItems
    );
}

function moveEntityToBlock(
    marker,
    targetBlock,
    maxItems
) {

    if (!targetBlock)
        return;

    if (!isContainer(targetBlock))
        return;

    const source =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    const target =
        targetBlock.getComponent(
            "inventory"
        )?.container;

    if (!source || !target)
        return;

    moveContainerItems(
        source,
        target,
        maxItems
    );
}

function moveEntityToAdjacentBlocks(
    marker,
    centerBlock,
    maxItems,
    excludeUp
) {

    const offsets = [
        { x: 1, y: 0, z: 0 },
        { x:-1, y: 0, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0, y: 0, z:-1 },
        { x: 0, y:-1, z: 0 }
    ];

    if (!excludeUp) {

        offsets.push({
            x: 0,
            y: 1,
            z: 0
        });

    }

    for (const offset of offsets) {

        const block =
            centerBlock.dimension.getBlock({
                x: centerBlock.location.x + offset.x,
                y: centerBlock.location.y + offset.y,
                z: centerBlock.location.z + offset.z
            });

        moveEntityToBlock(
            marker,
            block,
            maxItems
        );

    }

}

/* =========================================================
   MOVE ITEMS
========================================================= */

function moveContainerItems(
    source,
    target,
    maxItems
) {

    let transferred = 0;

    for (
        let slot = 0;
        slot < source.size;
        slot++
    ) {

        if (
            transferred >= maxItems
        ) {
            break;
        }

        const item =
            source.getItem(slot);

        if (!item)
            continue;

        const amount =
            Math.min(
                item.amount,
                maxItems -
                transferred
            );

        const clone =
            item.clone();

        clone.amount =
            amount;

        const leftover =
            target.addItem(
                clone
            );

        let success =
            amount;

        if (leftover) {
            success -=
                leftover.amount;
        }

        if (
            success <= 0
        ) {
            continue;
        }

        if (
            item.amount ===
            success
        ) {

            source.setItem(
                slot,
                undefined
            );

        } else {

            item.amount -=
                success;

            source.setItem(
                slot,
                item
            );

        }

        transferred +=
            success;
    }
}
