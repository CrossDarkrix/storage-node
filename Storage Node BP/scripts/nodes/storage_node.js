import {
    world,
    system
} from "@minecraft/server";

import {
    getAdjacentContainers,
    getBlockContainer,
    getRoundRobinTargets,
    advanceRoundRobin
} from "../core/container.js";

import {
    ModalFormData
} from "@minecraft/server-ui";

import {
    findMarkerAtBlock
} from "../core/marker.js";

import {
    moveBlockToEntity,
    moveContainerItems,
    canTransferToTarget
} from "../core/transfer.js";

import {
    STORAGE_NODE_ENTITY,
    STORAGE_NODE_BLOCK,
    DIMENSION_IDS
} from "../config/constants.js";
import {
    getNodeInputFaces,
    getNodeOutputFaces
} from "../core/node_direction.js";

/* =========================================================
   STORAGE NODE REDSTONE STATE SYNC
========================================================= */
const STORAGE_REDSTONE_COMPONENT = "vfh:storage_redstone_sync";

system.beforeEvents.startup.subscribe(event => {
    event.blockComponentRegistry.registerCustomComponent(
        STORAGE_REDSTONE_COMPONENT,
        {
            onRedstoneUpdate(redstoneEvent) {
                const block = redstoneEvent.block;
                if (!block || block.typeId !== STORAGE_NODE_BLOCK) {
                    return;
                }

                const powered = redstoneEvent.powerLevel > 0;
                const currentPowered = block.permutation.getState(
                    "vfh:storage_powered"
                );

                if (currentPowered === powered) {
                    return;
                }

                block.setPermutation(
                    block.permutation.withState(
                        "vfh:storage_powered",
                        powered
                    )
                );
            }
        }
    );
});

const openingStorageForm =
    new Set();

/* =========================================================
   ST-3B REDSTONE CONTROL MODES
========================================================= */
const STORAGE_REDSTONE_MODE_PROPERTY = "storage_redstone_mode";
const STORAGE_REDSTONE_MODE_BOTH = 0;
const STORAGE_REDSTONE_MODE_INPUT = 1;
const STORAGE_REDSTONE_MODE_OUTPUT = 2;
const STORAGE_REDSTONE_MODE_DISABLED = 3;
const STORAGE_REDSTONE_MODE_LABELS = Object.freeze([
    { translate: "vfh.ui.storage.redstone.both" },
    { translate: "vfh.ui.storage.redstone.input_only" },
    { translate: "vfh.ui.storage.redstone.output_only" },
    { translate: "vfh.ui.storage.redstone.disabled" }
]);

function getStorageRedstoneMode(marker) {
    const value = Number(
        marker.getDynamicProperty(
            STORAGE_REDSTONE_MODE_PROPERTY
        )
    );

    if (Number.isInteger(value) && value >= 0 && value <= 3) {
        return value;
    }

    return STORAGE_REDSTONE_MODE_BOTH;
}


/* =========================================================
   PLACE STORAGE NODE
========================================================= */

world.afterEvents.playerPlaceBlock.subscribe(ev => {

    const block = ev.block;

    if (
        block.typeId ===
        STORAGE_NODE_BLOCK
    ) {

        if (
            findMarkerAtBlock(
                block,
                STORAGE_NODE_ENTITY
            )
        ) {
            return;
        }

        const marker =
            block.dimension.spawnEntity(
                STORAGE_NODE_ENTITY,
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

        marker.setDynamicProperty(
            STORAGE_REDSTONE_MODE_PROPERTY,
            STORAGE_REDSTONE_MODE_BOTH
        );
    }
});

/* =========================================================
   OPEN STORAGE SETTINGS
========================================================= */

world.beforeEvents.playerInteractWithBlock.subscribe(ev => {

    const player = ev.player;

    if (!player.isSneaking)
        return;

    if (
        ev.block.typeId !==
        STORAGE_NODE_BLOCK
    ) {
        return;
    }

    if (ev.itemStack)
        return;

    const hopper =
        findMarkerAtBlock(
            ev.block,
            STORAGE_NODE_ENTITY
        );

    if (!hopper)
        return;

    ev.cancel = true;

    const formKey =
        `${player.id}:${ev.block.location.x}:${ev.block.location.y}:${ev.block.location.z}`;

    if (
        openingStorageForm.has(
            formKey
        )
    ) {
        return;
    }

    openingStorageForm.add(
        formKey
    );

    system.run(() => {

        const speed =
            Number(
                hopper.getDynamicProperty(
                    "fast_hopper_speed"
                )
            ) || 64;

        const redstoneMode =
            getStorageRedstoneMode(hopper);

        const form =
            new ModalFormData()
                .title({ translate: "vfh.ui.storage.title" })
                .slider(
                    { translate: "vfh.ui.storage.transfer_amount" },
                    1,
                    256,
                    {
                        defaultValue:
                            speed
                    }
                )
                .dropdown(
                    { translate: "vfh.ui.storage.redstone_control" },
                    STORAGE_REDSTONE_MODE_LABELS,
                    {
                        defaultValueIndex:
                            redstoneMode
                    }
                )
                .submitButton({ translate: "vfh.ui.common.save" });

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

                const selectedMode =
                    Number(
                        result.formValues[1]
                    );
                const mode =
                    Number.isInteger(selectedMode) &&
                    selectedMode >= 0 &&
                    selectedMode <= 3
                        ? selectedMode
                        : STORAGE_REDSTONE_MODE_BOTH;

                hopper.setDynamicProperty(
                    "fast_hopper_speed",
                    value
                );
                hopper.setDynamicProperty(
                    STORAGE_REDSTONE_MODE_PROPERTY,
                    mode
                );

                player.sendMessage({
                    translate: "vfh.ui.storage.saved"
                });

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

/* =========================================================
   FAST HOPPER ENGINE
========================================================= */

system.runInterval(() => {
    for (const dimId of DIMENSION_IDS) {

        const dimension =
            world.getDimension(dimId);

        const hoppers =
            dimension.getEntities({
                type: STORAGE_NODE_ENTITY
            });

        for (const marker of hoppers) {
            processFastHopper(marker);
        }
    }

}, 20);


/* =========================================================
   PROCESS STORAGE NODE
========================================================= */

export function processFastHopper(
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
        dimension.getBlock(
            pos
        );

    if (
        !hopper ||
        hopper.typeId !==
            STORAGE_NODE_BLOCK
    ) {

        /* marker.remove(); */
        return;
    }

    /* =====================================================
       ST-3B REDSTONE TRANSFER CONTROL
    ===================================================== */
    const powered =
        hopper.permutation.getState(
            "vfh:storage_powered"
        ) === true;
    const redstoneMode =
        getStorageRedstoneMode(marker);
    const inputEnabled =
        !(
            powered &&
            (
                redstoneMode === STORAGE_REDSTONE_MODE_BOTH ||
                redstoneMode === STORAGE_REDSTONE_MODE_INPUT
            )
        );
    const outputEnabled =
        !(
            powered &&
            (
                redstoneMode === STORAGE_REDSTONE_MODE_BOTH ||
                redstoneMode === STORAGE_REDSTONE_MODE_OUTPUT
            )
        );

    /*
     * INPUT
     *
     * Storage Node上部のContainerから
     * Marker Inventoryへ取り込む。
     */

    const inputDirection =
        getNodeInputFaces(hopper)[0] ?? null;

    const inputDirectionData =
        inputDirection
            ? {
                east:  { x: 1, y: 0, z: 0 },
                west:  { x: -1, y: 0, z: 0 },
                up:    { x: 0, y: 1, z: 0 },
                down:  { x: 0, y: -1, z: 0 },
                south: { x: 0, y: 0, z: 1 },
                north: { x: 0, y: 0, z: -1 }
            }[inputDirection]
            : null;

    const topBlock =
        inputDirectionData
            ? dimension.getBlock({
                x: pos.x + inputDirectionData.x,
                y: pos.y + inputDirectionData.y,
                z: pos.z + inputDirectionData.z
            })
            : null;

    if (inputEnabled) {
        moveBlockToEntity(
            topBlock,
            marker,
            speed
        );
    }

    if (!outputEnabled) {
        return;
    }

    /*
     * OUTPUT
     *
     * 隣接Containerを取得する。
     *
     * Storage Nodeでは上側はINPUTなので、
     * OUTPUT候補からupを除外する。
     */

    const outputFaces =
        getNodeOutputFaces(hopper);

    const excludedOutputFaces =
        [
            "east",
            "west",
            "up",
            "down",
            "south",
            "north"
        ].filter(
            direction =>
                !outputFaces.includes(direction)
        );

    const adjacentTargets =
        getAdjacentContainers(
            hopper,
            getBlockContainer,
            excludedOutputFaces,
            marker
        );

    const targets =
        adjacentTargets.filter(
            target =>
                canTransferToTarget(
                    STORAGE_NODE_ENTITY,
                    target,
                    hopper
                )
        );

    if (
        targets.length === 0
    ) {
        return;
    }

    /*
     * Marker Inventoryを取得する。
     */

    const source =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    if (!source) {
        return;
    }

    /*
     * Round Robin順に
     * 搬送候補を取得する。
     */

    const orderedTargets =
        getRoundRobinTargets(
            marker,
            targets
        );

    /*
     * 順番に搬送を試す。
     *
     * 第一候補が満杯なら、
     * 第二候補、第三候補へ
     * フォールバックする。
     */

    for (
        const target
        of orderedTargets
    ) {

        const moved =
            moveContainerItems(
                source,
                target.container,
                speed
            );

        if (
            moved <= 0
        ) {
            continue;
        }

        /*
         * 搬送成功。
         *
         * 次回は今回成功した
         * Containerの次から開始する。
         */

        advanceRoundRobin(
            marker,
            targets,
            target
        );

        break;
    }
}