import { world, system, EquipmentSlot } from "@minecraft/server";
import {
    openLinkedNetworkTerminal,
    prewarmLinkedNetworkTerminal,
    endRemoteCraftSession,
} from "./network_controller.js";
const R = "vfh:remote_order",
    C = "vfh:network_controller",
    K = "vfh:remote-order-link";
const linkCooldown = new Map(),
    useCooldown = new Map();
function held(p) {
    try {
        return (
            p.getComponent("minecraft:equippable")?.getEquipment(EquipmentSlot.Mainhand)?.typeId ===
            R
        );
    } catch {
        return false;
    }
}
function once(map, id, ticks) {
    const now = system.currentTick,
        last = map.get(id) ?? -99999;
    if (now - last < ticks) return false;
    map.set(id, now);
    return true;
}
world.beforeEvents.playerInteractWithBlock.subscribe((e) => {
    const p = e.player,
        b = e.block;
    if (!p || !b || b.typeId !== C || !p.isSneaking || !held(p)) return;
    e.cancel = true;
    if (!once(linkCooldown, p.id, 12)) return;
    system.run(() => {
        try {
            endRemoteCraftSession(p.id);
            p.setDynamicProperty(K, JSON.stringify({ d: b.dimension.id, x: b.x, y: b.y, z: b.z }));
            prewarmLinkedNetworkTerminal(p, b);
            p.sendMessage("Remote Order linked.");
        } catch (err) {
            (() => {})(`[Remote Order] link failed: ${err}`);
        }
    });
});
function linkedController(p) {
    let q;
    try {
        q = JSON.parse(p.getDynamicProperty(K) || "null");
    } catch {}
    if (!q) return;
    let b;
    try {
        b = world.getDimension(q.d).getBlock({ x: q.x, y: q.y, z: q.z });
    } catch {}
    return b?.typeId === C ? b : undefined;
}
function openRemoteOrder(p) {
    if (!p || p.isSneaking || !once(useCooldown, p.id, 8)) return;
    system.run(() => {
        const b = linkedController(p);
        if (!b) {
            endRemoteCraftSession(p.id);
            let q;
            try {
                q = JSON.parse(p.getDynamicProperty(K) || "null");
            } catch {}
            p.sendMessage(
                q ? "Linked Network Controller is unavailable." : "Remote Order is not linked.",
            );
            return;
        }
        if (!openLinkedNetworkTerminal(p, b)) p.sendMessage("Could not open linked terminal.");
    });
}
// Simple Storage-style pre-generation: while Remote Order is held, keep the remote terminal session/entity ready before itemUse.
system.runInterval(() => {
    for (const p of world.getAllPlayers()) {
        if (!p?.isValid) continue;
        if (!held(p)) {
            endRemoteCraftSession(p.id);
            continue;
        }
        const b = linkedController(p);
        if (!b) {
            endRemoteCraftSession(p.id);
            continue;
        }
        prewarmLinkedNetworkTerminal(p, b);
    }
}, 4);
world.beforeEvents.itemUse.subscribe((e) => {
    const p = e.source;
    if (!p || e.itemStack?.typeId !== R || p.isSneaking) return;
    openRemoteOrder(p);
});
world.afterEvents.itemUse.subscribe((e) => {
    const p = e.source;
    if (!p || e.itemStack?.typeId !== R || p.isSneaking) return;
    openRemoteOrder(p);
});
