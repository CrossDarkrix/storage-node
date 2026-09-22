export function findMarkerAtBlock(
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

export function dropEntityInventory(
    marker
) {

    const inventory =
        marker.getComponent(
            "minecraft:inventory"
        )?.container;

    if (!inventory)
        return;

    for (
        let slot = 0;
        slot < inventory.size;
        slot++
    ) {

        const item =
            inventory.getItem(slot);

        if (!item)
            continue;

        marker.dimension.spawnItem(
            item,
            {
                x: marker.location.x,
                y: marker.location.y + 0.5,
                z: marker.location.z
            }
        );

        inventory.setItem(
            slot,
            undefined
        );
    }
}