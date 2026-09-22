import {
    STORAGE_NODE_ENTITY,
    VACUUM_NODE_ENTITY,
    SIDE_NODE_ENTITY,
    CENTER_NODE_ENTITY,
    ENDER_NODE_ENTITY
} from "../config/constants.js";

const roundRobinCursors =
    new Map();

export const ADJACENT_DIRECTIONS = [
    {
        name: "east",
        x: 1,
        y: 0,
        z: 0
    },
    {
        name: "west",
        x: -1,
        y: 0,
        z: 0
    },
    {
        name: "up",
        x: 0,
        y: 1,
        z: 0
    },
    {
        name: "down",
        x: 0,
        y: -1,
        z: 0
    },
    {
        name: "south",
        x: 0,
        y: 0,
        z: 1
    },
    {
        name: "north",
        x: 0,
        y: 0,
        z: -1
    }
];


export function getEntityContainerAtBlock(
    block,
    excludedEntity = null
)
{
    if (!block) {
        return null;
    }
    /* CENTER C5 V150 ENTITY TARGET */
    const centerMarker = block.dimension
        .getEntities({ type: CENTER_NODE_ENTITY })
        .find(entity =>
            entity !== excludedEntity &&
            Math.floor(entity.location.x) === block.location.x &&
            Math.floor(entity.location.y) === block.location.y &&
            Math.floor(entity.location.z) === block.location.z
        );
    if (centerMarker) {
        const container = centerMarker.getComponent("minecraft:inventory")?.container;
        if (container) {
            /* CENTER C5 V150 TARGET CONTRACT FIX */
            return {
                container,
                entity: centerMarker
            };
        }
    }


    let entities;

    try {

        entities =
            block.dimension.getEntities({
                location: {
                    x: block.location.x + 0.5,
                    y: block.location.y + 0.5,
                    z: block.location.z + 0.5
                },
                maxDistance: 1
            });

    } catch {
        return null;
    }

    for (const entity of entities) {

        /*
         * Player Inventoryは
         * 自動搬送対象にしない。
         */

        if (
            entity.typeId ===
            "minecraft:player"
        ) {
            continue;
        }

        /*
         * 現在処理中のMarker自身も除外。
         */

        if (
            excludedEntity &&
            entity.id ===
                excludedEntity.id
        ) {
            continue;
        }

        const ex =
            Math.floor(
                entity.location.x
            );

        const ey =
            Math.floor(
                entity.location.y
            );

        const ez =
            Math.floor(
                entity.location.z
            );

        if (
            ex !== block.location.x ||
            ey !== block.location.y ||
            ez !== block.location.z
        ) {
            continue;
        }

        try {

            const container =
                entity.getComponent(
                    "minecraft:inventory"
                )?.container;

            if (container) {

                return {
                    container,
                    entity
                };
            }

        } catch {
            continue;
        }
    }

    return null;
}


export function isSafeBlockContainer(block)
{
    if (!block) {
        return false;
    }

    try {
        /*
         * Production safety policy:
         * only vanilla minecraft:* block inventories are accepted as
         * external block containers. Custom/add-on namespaces are blocked
         * for both input and output until compatibility is verified.
         */
        return typeof block.typeId === "string" &&
            block.typeId.startsWith("minecraft:");
    } catch {
        return false;
    }
}

export function getBlockContainer(
    block,
    excludedEntity = null
)
{
    if (!block) {
        return null;
    }

    if (!isSafeBlockContainer(block)) {
        return null;
    }

    try {

        const blockContainer =
            block.getComponent(
                "inventory"
            )?.container;

        if (blockContainer) {
            return blockContainer;
        }

    } catch {}

    const entityResult =
        getEntityContainerAtBlock(
            block,
            excludedEntity
        );

    return (
        entityResult?.container ??
        null
    );
}


export function getContainerStats(
    container
)
{
    if (!container) {
        return null;
    }

    try {

        if (!container.isValid) {
            return null;
        }

        const size =
            container.size;

        const emptySlots =
            container.emptySlotsCount;

        let itemCount = 0;

        for (
            let slotIndex = 0;
            slotIndex < size;
            slotIndex++
        ) {

            const item =
                container.getItem(
                    slotIndex
                );

            if (!item) {
                continue;
            }

            itemCount +=
                item.amount;
        }

        return {
            size,
            emptySlots,
            usedSlots:
                size - emptySlots,
            itemCount
        };

    } catch (error) {

        console.warn(
            `[VFH] Failed to read container stats: ${error}`
        );

        return null;
    }
}


export function getAdjacentContainers(
    centerBlock,
    getContainerAtBlock =
        getBlockContainer,
    excludedDirection = null,
    excludedEntity = null
)
{
    if (!centerBlock) {
        return [];
    }

    const results = [];

    for (
        const direction
        of ADJACENT_DIRECTIONS
    ) {

        const excludedDirections =
            Array.isArray(excludedDirection)
                ? excludedDirection
                : excludedDirection !== null
                    ? [excludedDirection]
                    : [];

        if (
            excludedDirections.includes(
                direction.name
            )
        ) {
            continue;
        }

        let block;

        try {

            block =
                centerBlock.dimension.getBlock({
                    x:
                        centerBlock.location.x +
                        direction.x,
                    y:
                        centerBlock.location.y +
                        direction.y,
                    z:
                        centerBlock.location.z +
                        direction.z
                });

        } catch {
            continue;
        }

        if (!block) {
            continue;
        }

        /*
         * 詳細Target取得。
         */

        const target =
            getContainerTargetAtBlock(
                block,
                excludedEntity
            );

        if (!target) {
            continue;
        }

        const stats =
            getContainerStats(
                target.container
            );

        if (!stats) {
            continue;
        }

        results.push({
            direction:
                direction.name,

            block,

            container:
                target.container,

            targetType:
                target.type,

            entity:
                target.entity,
            /* CENTER C5 V150 ADJACENT POLICY FIX V2 */
            entityInventoryPolicy:
                target.entityInventoryPolicy ?? null,

            stats
        });
    }

    return results;
}


export function getRoundRobinTargets(
    marker,
    targets
)
{
    if (
        !marker ||
        !Array.isArray(targets) ||
        targets.length === 0
    ) {
        return [];
    }

    const key =
        marker.id;

    let cursor =
        roundRobinCursors.get(key);

    if (
        !Number.isInteger(cursor) ||
        cursor < 0
    ) {
        cursor = 0;
    }

    if (
        cursor >= targets.length
    ) {
        cursor = 0;
    }

    const orderedTargets = [];

    for (
        let offset = 0;
        offset < targets.length;
        offset++
    ) {

        const index =
            (
                cursor +
                offset
            ) %
            targets.length;

        orderedTargets.push(
            targets[index]
        );
    }

    return orderedTargets;
}


export function advanceRoundRobin(
    marker,
    targets,
    usedTarget
)
{
    if (
        !marker ||
        !Array.isArray(targets) ||
        targets.length === 0 ||
        !usedTarget
    ) {
        return;
    }

    const usedIndex =
        targets.indexOf(
            usedTarget
        );

    if (usedIndex < 0) {
        return;
    }

    const nextIndex =
        (
            usedIndex +
            1
        ) %
        targets.length;

    roundRobinCursors.set(
        marker.id,
        nextIndex
    );
}


export function clearRoundRobin(
    marker
)
{
    if (!marker) {
        return;
    }

    roundRobinCursors.delete(
        marker.id
    );
}

export function getContainerTargetAtBlock(
    block,
    excludedEntity = null
)
{
    if (!block) {
        return null;
    }

    /*
     * Block Inventoryを優先。
     * Add-on/custom block containers are intentionally unsupported.
     */

    if (!isSafeBlockContainer(block)) {
        /* VFH node marker inventories are resolved below as entity targets. */
        const vfhEntityResult = getEntityContainerAtBlock(block, excludedEntity);
        if (!vfhEntityResult) return null;
        const vfhEntityType = vfhEntityResult.entity.typeId;
        const isVfhEntity =
            vfhEntityType === STORAGE_NODE_ENTITY ||
            vfhEntityType === VACUUM_NODE_ENTITY ||
            vfhEntityType === SIDE_NODE_ENTITY ||
            vfhEntityType === CENTER_NODE_ENTITY ||
            vfhEntityType === ENDER_NODE_ENTITY;
        if (!isVfhEntity) return null;
        return {
            type: "entity", block, entity: vfhEntityResult.entity,
            container: vfhEntityResult.container, entityInventoryPolicy: "vfh"
        };
    }

    try {

        const blockContainer =
            block.getComponent(
                "inventory"
            )?.container;

        if (blockContainer) {

            return {
                type: "block",
                block,
                entity: null,
                container:
                    blockContainer
            };
        }

    } catch {}

    /*
     * Block Inventoryが無ければ
     * Entity Inventoryを探す。
     */

    const entityResult =
        getEntityContainerAtBlock(
            block,
            excludedEntity
        );

    if (!entityResult) {
        return null;
    }

    const entityType =
        entityResult.entity.typeId;

    /* CENTER C5 V150 VFH POLICY FIX */
    const isVfhEntity =
        entityType === STORAGE_NODE_ENTITY ||
        entityType === VACUUM_NODE_ENTITY ||
        entityType === SIDE_NODE_ENTITY ||
        entityType === CENTER_NODE_ENTITY ||
        entityType === ENDER_NODE_ENTITY;

    return {
        type: "entity",
        block,
        entity:
            entityResult.entity,
        container:
            entityResult.container,
        entityInventoryPolicy:
            isVfhEntity
                ? "vfh"
                : "external"
    };
}