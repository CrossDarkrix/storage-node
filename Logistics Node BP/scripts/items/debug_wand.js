import { world, system, EquipmentSlot } from "@minecraft/server";
import { tryEmergencyLargeContainerRemove } from "../nodes/large_container.js";
const WAND = "vfh:debug_wand",
    ENTITY = "vfh:large_container_storage";
function held(p) {
    try {
        return (
            p?.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)
                ?.typeId === WAND
        );
    } catch {
        return false;
    }
}
function consume(p) {
    try {
        const eq = p.getComponent("minecraft:equippable");
        const s = eq?.getEquipment(EquipmentSlot.Mainhand);
        if (s?.typeId !== WAND) return false;
        if (s.amount > 1) {
            s.amount--;
            eq.setEquipment(EquipmentSlot.Mainhand, s);
        } else eq.setEquipment(EquipmentSlot.Mainhand, undefined);
        return true;
    } catch {
        return false;
    }
}
world.afterEvents.entityHitEntity.subscribe((ev) => {
    const p = ev.damagingEntity,
        t = ev.hitEntity;
    if (p?.typeId !== "minecraft:player" || !held(p) || t?.typeId !== ENTITY) return;
    system.run(() => {
        if (tryEmergencyLargeContainerRemove(t, p)) consume(p);
    });
});
world.afterEvents.itemUse.subscribe((ev) => {
    if (ev.source?.typeId === "minecraft:player" && ev.itemStack?.typeId === WAND)
        ev.source.sendMessage(
            "§7一時コンテナ削除: Large Container の残留エンティティに使用してください。",
        );
});
