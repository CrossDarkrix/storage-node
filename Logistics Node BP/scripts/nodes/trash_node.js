import { world, system } from "@minecraft/server";
import { TRASH_NODE_BLOCK, TRASH_NODE_BUFFER_ENTITY, DIMENSION_IDS } from "../config/constants.js";
import { ensureMarkerForBlock, findMarkerAtBlock } from "../core/marker.js";

const MAX_DELETE_PER_TICK = 256;

function ensureBuffer(block) {
  return ensureMarkerForBlock(block, TRASH_NODE_BUFFER_ENTITY, null, TRASH_NODE_BLOCK);
}
export function getTrashBuffer(block) {
  if (!block || block.typeId !== TRASH_NODE_BLOCK) return undefined;
  const marker = ensureBuffer(block);
  try {
    const c = marker?.getComponent("minecraft:inventory")?.container;
    return c?.isValid ? c : undefined;
  } catch { return undefined; }
}
function purgeBuffer(marker) {
  let remaining = MAX_DELETE_PER_TICK;
  let removed = 0;
  let c;
  try { c = marker.getComponent("minecraft:inventory")?.container; } catch { return 0; }
  if (!c?.isValid) return 0;
  for (let slot=0; slot<c.size && remaining>0; slot++) {
    const item=c.getItem(slot);
    if (!item) continue;
    const amount=Math.min(item.amount ?? 1, remaining);
    const left=(item.amount ?? 1)-amount;
    if (left<=0) c.setItem(slot,undefined);
    else { const kept=item.clone(); kept.amount=left; c.setItem(slot,kept); }
    removed+=amount; remaining-=amount;
  }
  return removed;
}
world.afterEvents.playerPlaceBlock.subscribe(ev=>{
  if(ev.block?.typeId===TRASH_NODE_BLOCK) system.run(()=>ensureBuffer(ev.block));
});
world.afterEvents.playerInteractWithBlock.subscribe(ev=>{
  if(ev.block?.typeId===TRASH_NODE_BLOCK) system.run(()=>ensureBuffer(ev.block));
});
world.afterEvents.playerBreakBlock.subscribe(ev=>{
  if(ev.brokenBlockPermutation?.type?.id!==TRASH_NODE_BLOCK) return;
  const marker=findMarkerAtBlock(ev.block,TRASH_NODE_BUFFER_ENTITY);
  if(marker) try{marker.remove();}catch{}
});
system.runInterval(()=>{
  for(const id of DIMENSION_IDS){
    let dim; try{dim=world.getDimension(id);}catch{continue;}
    for(const marker of dim.getEntities({type:TRASH_NODE_BUFFER_ENTITY})){
      const l=marker.location;
      const block=dim.getBlock({x:Math.floor(l.x),y:Math.floor(l.y),z:Math.floor(l.z)});
      if(block?.typeId!==TRASH_NODE_BLOCK){try{marker.remove();}catch{}continue;}
      purgeBuffer(marker);
    }
  }
},1);
