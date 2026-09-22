import {
    getBlockContainer } from "./container.js"; import {     canNodeConnectToNode } from "./node_direction.js";  import {     STORAGE_NODE_ENTITY,
    VACUUM_NODE_ENTITY,
    SIDE_NODE_ENTITY,
    CENTER_NODE_ENTITY
} from "../config/constants.js";



export function canTransferToTarget(
    sourceType,
    target,
    sourceBlock = null
) {
    if (sourceType === SIDE_NODE_ENTITY) {
    }

    if (!target) return false;

    // v1.5.0 container.js represents VFH marker inventories as entity targets.
    // Route those through the same C3/C4 block-face gate before entity policy checks.
    /* SIDE S2-A VFH NODE GATE FIX */
    const targetIsVfhNode =
        target.targetType === "node" ||
        (
            target.targetType === "entity" &&
            target.entityInventoryPolicy === "vfh"
        );
    /* SIDE S2-A EXTERNAL OUTPUT FIX */
    // External block inventories (chests, barrels, etc.) do not participate in
    // Node-to-Node C3/C4 face negotiation. Side output-face filtering has
    // already happened in processSideNode/getAdjacentContainers.
    if (target.targetType === "block") return true;


    if (
        targetIsVfhNode &&
        !canNodeConnectToNode(
            sourceBlock,
            target.direction,
            target.block
        )
    ) {
        return false;
    }

    
    if (target.targetType !== "entity" || !target.entity) return false;
    if (target.entityInventoryPolicy !== "vfh") return false;

    const targetType = target.entity.typeId;

    if (sourceType === STORAGE_NODE_ENTITY) {
        if (targetType === VACUUM_NODE_ENTITY) return false;
        return (
            targetType === STORAGE_NODE_ENTITY ||
            targetType === CENTER_NODE_ENTITY
        );
    }

    /* SIDE S2-A CENTER TARGET FIX */
    if (sourceType === SIDE_NODE_ENTITY) {
        if (targetType === VACUUM_NODE_ENTITY) return false;
        return (
            targetType === STORAGE_NODE_ENTITY ||
            targetType === SIDE_NODE_ENTITY ||
            targetType === CENTER_NODE_ENTITY
        );
    }

    if (sourceType === CENTER_NODE_ENTITY) {
        if (targetType === VACUUM_NODE_ENTITY) return false;
        return (
            targetType === STORAGE_NODE_ENTITY ||
            targetType === SIDE_NODE_ENTITY
        );
    }

    if (sourceType === VACUUM_NODE_ENTITY) {
        return targetType === STORAGE_NODE_ENTITY;
    }

    return false;
}

export function moveContainerItems(
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

        if (!item) {
            continue;
        }

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

    return transferred;
}



export function moveBlockToEntity(
    sourceBlock,
    marker,
    maxItems
)
{
    const source =
        getBlockContainer(
            sourceBlock
        );

    const target =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    if (!source || !target) {
        return 0;
    }

    return moveContainerItems(
        source,
        target,
        maxItems
    );
}

export function moveEntityToBlock(
    marker,
    targetBlock,
    maxItems
)
{
    const source =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    const target =
        getBlockContainer(
            targetBlock
        );

    if (!source || !target) {
        return 0;
    }

    return moveContainerItems(
        source,
        target,
        maxItems
    );
}


export function moveEntityToAdjacentBlocks(
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