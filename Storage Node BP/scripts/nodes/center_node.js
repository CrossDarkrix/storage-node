import { world, system } from "@minecraft/server";
import { CENTER_NODE_BLOCK, CENTER_NODE_ENTITY, SIDE_NODE_BLOCK, SIDE_NODE_ENTITY, DIMENSION_IDS } from "../config/constants.js";
import { findMarkerAtBlock, dropEntityInventory } from "../core/marker.js";
import { ModalFormData } from "@minecraft/server-ui";
import { getAdjacentContainers, getRoundRobinTargets, advanceRoundRobin } from "../core/container.js";
import { canTransferToTarget, moveContainerItems } from "../core/transfer.js";
import { ALL_DIRECTIONS, getNodeOutputFaces, getNodeInputFaces, getOppositeDirection, canNodeConnectToNode } from "../core/node_direction.js";

/* CENTER NODE C1: lifecycle only. Transfer/routing/network is intentionally disabled. */

/* CENTER MARKER LIFECYCLE TRACE */
world.afterEvents.playerPlaceBlock.subscribe(ev => {
    const block = ev.block;
    if (!block || block.typeId !== CENTER_NODE_BLOCK) return;
    if (findMarkerAtBlock(block, CENTER_NODE_ENTITY)) return;
    const marker = block.dimension.spawnEntity(CENTER_NODE_ENTITY, {
        x: block.location.x + 0.5,
        y: block.location.y + 0.5,
        z: block.location.z + 0.5,
    });
});

world.afterEvents.playerBreakBlock.subscribe(ev => {
    const block = ev.block;
    if (!block) return;
    const brokenType = ev.brokenBlockPermutation?.type?.id ?? ev.brokenBlockPermutation?.typeId ?? "";
    if (brokenType !== CENTER_NODE_BLOCK) return;
    const marker = block.dimension.getEntities({ type: CENTER_NODE_ENTITY }).find(entity =>
        Math.floor(entity.location.x) === block.location.x &&
        Math.floor(entity.location.y) === block.location.y &&
        Math.floor(entity.location.z) === block.location.z
    );
    if (!marker) return;
    dropEntityInventory(marker);
marker.remove();
});

system.runInterval(() => {
    for (const dimensionId of DIMENSION_IDS) {
        const dimension = world.getDimension(dimensionId);
        for (const marker of dimension.getEntities({ type: CENTER_NODE_ENTITY })) {
            const pos = { x: Math.floor(marker.location.x), y: Math.floor(marker.location.y), z: Math.floor(marker.location.z) };
            const block = dimension.getBlock(pos);
            if (block && block.typeId === CENTER_NODE_BLOCK) continue;
            dropEntityInventory(marker);
marker.remove();
        }
    }
}, 20);

/* CENTER NODE C2 FACE UI START */
const CENTER_FACE_MODES = Object.freeze([
    { translate: "vfh.ui.face.disabled" },
    { translate: "vfh.ui.face.input" },
    { translate: "vfh.ui.face.output" },
]);

const CENTER_FACE_CONFIG = Object.freeze([
    [{ translate: "vfh.ui.face.north" }, "center_face_north"],
    [{ translate: "vfh.ui.face.south" }, "center_face_south"],
    [{ translate: "vfh.ui.face.east" }, "center_face_east"],
    [{ translate: "vfh.ui.face.west" }, "center_face_west"],
    [{ translate: "vfh.ui.face.up" }, "center_face_up"],
    [{ translate: "vfh.ui.face.down" }, "center_face_down"],
]);

const centerFaceUiOpen = new Set();
const centerFaceUiCooldown = new Map();
const CENTER_FACE_UI_COOLDOWN_TICKS = 8;

function normalizeCenterFaceMode(value) {
    return Number.isInteger(value) && value >= 0 && value < CENTER_FACE_MODES.length
        ? value
        : 0;
}

function getCenterFaceMode(marker, propertyName) {
    return normalizeCenterFaceMode(marker?.getDynamicProperty(propertyName));
}

function setCenterFaceMode(marker, propertyName, value) {
    marker.setDynamicProperty(propertyName, normalizeCenterFaceMode(value));
}

function getCenterFaceUiKey(player) {
    return player?.id ?? player?.name ?? "unknown";
}

function canOpenCenterFaceUi(player) {
    const key = getCenterFaceUiKey(player);
    if (centerFaceUiOpen.has(key)) return false;

    const now = system.currentTick;
    const last = centerFaceUiCooldown.get(key) ?? -1000;
    if (now - last < CENTER_FACE_UI_COOLDOWN_TICKS) return false;

    centerFaceUiCooldown.set(key, now);
    return true;
}

function openCenterFaceSettings(player, block) {
    if (!player || !block || block.typeId !== CENTER_NODE_BLOCK) return;
    if (!canOpenCenterFaceUi(player)) return;

    const marker = findMarkerAtBlock(block, CENTER_NODE_ENTITY);
    if (!marker) {
        player.sendMessage({ translate: "vfh.ui.center.marker_missing" });
        return;
    }

    const key = getCenterFaceUiKey(player);
    centerFaceUiOpen.add(key);

    const form = new ModalFormData()
        .title({ translate: "vfh.ui.center.title" });

    for (const [label, propertyName] of CENTER_FACE_CONFIG) {
        form.dropdown(label, CENTER_FACE_MODES, {
            defaultValueIndex: getCenterFaceMode(marker, propertyName),
        });
    }

    form.submitButton({ translate: "vfh.ui.common.save" });

    system.run(() => {
        form.show(player)
            .then(response => {
                if (
                    response.canceled ||
                    !Array.isArray(response.formValues) ||
                    response.formValues.length !== CENTER_FACE_CONFIG.length
                ) {
                    return;
                }
                for (let index = 0; index < CENTER_FACE_CONFIG.length; index++) {
                    setCenterFaceMode(
                        marker,
                        CENTER_FACE_CONFIG[index][1],
                        response.formValues[index]
                    );
                }
                player.sendMessage({ translate: "vfh.ui.center.saved" });
            })
            .catch(error => {
                console.warn(`[Center Node C2] UI failed: ${error}`);
            })
            .finally(() => {
                centerFaceUiOpen.delete(key);
                centerFaceUiCooldown.set(key, system.currentTick);
            });
    });
}

world.beforeEvents.playerInteractWithBlock.subscribe(ev => {
    const block = ev.block;
    const player = ev.player;

    if (!block || block.typeId !== CENTER_NODE_BLOCK) return;
    if (!player?.isSneaking) return;

    const selected = player.getComponent("minecraft:inventory")
        ?.container?.getItem(player.selectedSlotIndex);
    if (selected) return;

    ev.cancel = true;
    openCenterFaceSettings(player, block);
});
/* CENTER NODE C2 FACE UI END */

/* CENTER NODE C5 TRANSFER START */
const CENTER_TRANSFER_INTERVAL_TICKS = 1;
const CENTER_TRANSFER_AMOUNT = 64;
function getCenterMarkerInventory(block) {
    const marker = findMarkerAtBlock(block, CENTER_NODE_ENTITY);
    return {
        marker,
        container: marker?.getComponent("minecraft:inventory")?.container ?? null,
    };
}

function runCenterTransfer(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK) return;
const { marker, container } = getCenterMarkerInventory(block);
    if (!marker || !container) return;

    const outputFaces = getNodeOutputFaces(block);
    const excludedOutputFaces = ALL_DIRECTIONS.filter(
        direction => !outputFaces.includes(direction)
    );
    const targets = getAdjacentContainers(
        block,
        undefined,
        excludedOutputFaces,
        marker
    );
    if (!Array.isArray(targets) || targets.length === 0) return;

    const allowedTargets = targets.filter(target =>
        canTransferToTarget(
            CENTER_NODE_ENTITY,
            target,
            block
        )
    );
    if (allowedTargets.length === 0) return;

    const orderedTargets = getRoundRobinTargets(marker, allowedTargets);
    for (const target of orderedTargets) {
        const moved = moveContainerItems(
            container,
            target.container,
            CENTER_TRANSFER_AMOUNT
        );
        if (moved > 0) {
            advanceRoundRobin(marker, allowedTargets, target);
            break;
        }
    }
}

system.runInterval(() => {
    for (const dimensionId of DIMENSION_IDS) {
        const dimension = world.getDimension(dimensionId);
        for (const marker of dimension.getEntities({ type: CENTER_NODE_ENTITY })) {
            const pos = {
                x: Math.floor(marker.location.x),
                y: Math.floor(marker.location.y),
                z: Math.floor(marker.location.z),
            };
            const block = dimension.getBlock(pos);
            if (block?.typeId === CENTER_NODE_BLOCK) {
                runCenterTransfer(block);
            }
        }
    }
}, CENTER_TRANSFER_INTERVAL_TICKS);
/* CENTER NODE C5 TRANSFER END */
