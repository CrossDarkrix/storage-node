import { system, world } from "@minecraft/server";
import { OUTPUT_NODE_BLOCK, OUTPUT_NODE_ENTITY, SIDE_NODE_BLOCK, SIDE_NODE_ENTITY, TRASH_NODE_BLOCK, DIMENSION_IDS } from "../config/constants.js";
import { ADJACENT_DIRECTIONS, getContainerTargetAtBlock, isSafeBlockContainer } from "../core/container.js";
import { buildNetworkItemIndex } from "../core/network_item_index.js";
import { ensureMarkerForBlock, findMarkerAtBlock } from "../core/marker.js";
import { getTrashBuffer } from "./trash_node.js";

const FILTER_ENTITY="entity:output_node_filter_terminal";
const FILTER_HOME="vfh:output_node_filter_home";
const INTERVAL=1, MAX_ITEMS=64;
// OUT-C1: cache the resolved source slot and throttle full network discovery.
const SOURCE_RESCAN_TICKS=20;
const SOURCE_CACHE=new Map();
function adjacent(block,d){try{return block.dimension.getBlock({x:block.location.x+d.x,y:block.location.y+d.y,z:block.location.z+d.z});}catch{return undefined;}}
function ensure(block){return ensureMarkerForBlock(block,OUTPUT_NODE_ENTITY,null,OUTPUT_NODE_BLOCK);}
function filterKey(block){return `${block.dimension.id}|${block.location.x}|${block.location.y}|${block.location.z}`;}
function filterCenter(block){return {x:block.location.x+0.5,y:block.location.y+0.5,z:block.location.z+0.5};}
function findFilter(block){
  const k=filterKey(block);
  for(const e of block.dimension.getEntities({type:FILTER_ENTITY})){
    try{if(e.getDynamicProperty(FILTER_HOME)===k)return e;}catch{}
  }
  return undefined;
}
function ensureFilter(block){
  let e=findFilter(block);
  if(!e){try{e=block.dimension.spawnEntity(FILTER_ENTITY,filterCenter(block));}catch{return undefined;}}
  try{e.setDynamicProperty(FILTER_HOME,filterKey(block));e.nameTag="Output Node Filter";}catch{}
  return e;
}
function selfHealFilter(block){
  const home=filterKey(block), center=filterCenter(block);
  let primary=findFilter(block);
  const nearby=[];
  try{for(const e of block.dimension.getEntities({type:FILTER_ENTITY,location:center,maxDistance:1.5}))nearby.push(e);}catch{}
  if(!primary){
    const donor=nearby.find(e=>{try{return !e.getDynamicProperty(FILTER_HOME);}catch{return true;}});
    if(donor){
      primary=donor;
      try{primary.setDynamicProperty(FILTER_HOME,home);primary.nameTag="Output Node Filter";}catch{}
    }else primary=ensureFilter(block);
  }
  if(!primary)return undefined;
  const pc=primary.getComponent("minecraft:inventory")?.container;
  for(const e of nearby){
    if(e.id===primary.id)continue;
    let eh="";try{eh=String(e.getDynamicProperty(FILTER_HOME)??"");}catch{}
    if(eh&&eh!==home)continue;
    const ec=e.getComponent("minecraft:inventory")?.container;
    try{
      const item=ec?.getItem(0);
      if(item&&pc&&!pc.getItem(0)){pc.setItem(0,item);ec.setItem(0,undefined);}
      else if(item){continue;}
      e.remove();
    }catch{}
  }
  try{primary.setDynamicProperty(FILTER_HOME,home);primary.nameTag="Output Node Filter";}catch{}
  return primary;
}
function filterType(block){const e=findFilter(block),c=e?.getComponent("minecraft:inventory")?.container,it=c?.getItem(0);return it?.typeId??"";}
function fit(c,item){if(!c?.isValid||!item)return false;for(let i=0;i<c.size;i++){const x=c.getItem(i);if(!x)return true;if(x.isStackableWith?.(item)&&x.amount<(x.maxAmount??64))return true;}return false;}
function sourceCacheKey(node,typeId){return `${filterKey(node)}|${typeId}`;}
function resolveCachedSource(cache,typeId){
  if(!cache)return undefined;
  try{
    const b=world.getDimension(cache.dimensionId).getBlock(cache.location);
    const c=getContainerTargetAtBlock?.(b)?.container??(isSafeBlockContainer(b)?b.getComponent("inventory")?.container:undefined);
    if(!c?.isValid)return undefined;
    const item=c.getItem(cache.slot);
    if(item?.typeId!==typeId)return undefined;
    return {container:c,slot:cache.slot,item};
  }catch{return undefined;}
}
function buildSource(node,typeId){
  const key=sourceCacheKey(node,typeId), now=system.currentTick;
  const cached=SOURCE_CACHE.get(key);
  const live=resolveCachedSource(cached,typeId);
  if(live)return live;
  if(cached&&now<(cached.nextScanTick??0))return undefined;
  const index=buildNetworkItemIndex(node),entry=index?.byTypeId?.get(typeId);
  if(!entry?.total){SOURCE_CACHE.set(key,{nextScanTick:now+SOURCE_RESCAN_TICKS});return undefined;}
  const byKey=new Map((index.storage?.containers??[]).map(t=>[t.key,t]));
  for(const loc of entry.locations??[]){
    const storage=byKey.get(loc.containerKey), c=storage?.container;
    if(!c?.isValid)continue;
    try{
      const item=c.getItem(loc.slot);
      if(item?.typeId!==typeId)continue;
      SOURCE_CACHE.set(key,{dimensionId:storage.dimensionId,location:{...storage.location},slot:loc.slot,nextScanTick:now+SOURCE_RESCAN_TICKS});
      return {container:c,slot:loc.slot,item};
    }catch{}
  }
  SOURCE_CACHE.set(key,{nextScanTick:now+SOURCE_RESCAN_TICKS});
  return undefined;
}
function destination(block){if(!block)return undefined;if(block.typeId===TRASH_NODE_BLOCK)return getTrashBuffer(block);if(block.typeId===SIDE_NODE_BLOCK){const m=findMarkerAtBlock(block,SIDE_NODE_ENTITY);const c=m?.getComponent("minecraft:inventory")?.container;return c?.isValid?c:undefined;}if(!isSafeBlockContainer(block))return undefined;try{return block.getComponent("inventory")?.container;}catch{return undefined;}}
function commitOne(source,target){const current=source.container.getItem(source.slot);if(!current||current.typeId!==source.item.typeId)return 0;const amount=Math.min(MAX_ITEMS,current.amount);const moving=current.clone();moving.amount=amount;const left=target.addItem(moving);const moved=amount-(left?.amount??0);if(moved<=0)return 0;if(current.amount===moved)source.container.setItem(source.slot,undefined);else{const remain=current.clone();remain.amount-=moved;source.container.setItem(source.slot,remain);}return moved;}
function process(node){if(!ensure(node))return;selfHealFilter(node);const typeId=filterType(node);if(!typeId)return;const source=buildSource(node,typeId);if(!source)return;for(const d of ADJACENT_DIRECTIONS){const b=adjacent(node,d);if(!b)continue;const target=destination(b);if(!target||target===source.container||!fit(target,source.item))continue;try{if(commitOne(source,target)>0)return;}catch{}}}
world.beforeEvents.playerInteractWithBlock.subscribe(ev=>{
  if(ev.block.typeId!==OUTPUT_NODE_BLOCK||!ev.player.isSneaking)return;
  ev.cancel=true;const dim=ev.block.dimension,loc={...ev.block.location};
  system.run(()=>{try{const b=dim.getBlock(loc);if(b?.typeId!==OUTPUT_NODE_BLOCK)return;ensure(b);const e=selfHealFilter(b);if(e)e.teleport(filterCenter(b),{dimension:dim});}catch{}});
});
world.beforeEvents.playerBreakBlock.subscribe(ev=>{
  if(!ev.player.isSneaking||ev.block.typeId!==OUTPUT_NODE_BLOCK)return;
  const dim=ev.block.dimension,loc={...ev.block.location};const player=ev.player;
  system.run(()=>{try{const b=dim.getBlock(loc);if(b?.typeId!==OUTPUT_NODE_BLOCK)return;const e=findFilter(b);if(!e)return;const p=player.location;e.teleport({x:p.x,y:p.y+10,z:p.z},{dimension:player.dimension});}catch{}});
});
world.afterEvents.playerPlaceBlock.subscribe(ev=>{if(ev.block?.typeId===OUTPUT_NODE_BLOCK)system.run(()=>{ensure(ev.block);selfHealFilter(ev.block);});});
world.afterEvents.playerBreakBlock.subscribe(ev=>{if(ev.brokenBlockPermutation?.type?.id!==OUTPUT_NODE_BLOCK&&ev.block?.typeId!==OUTPUT_NODE_BLOCK)return;for(const k of [...SOURCE_CACHE.keys()]){if(k.startsWith(filterKey(ev.block)+"|"))SOURCE_CACHE.delete(k);}const m=findMarkerAtBlock(ev.block,OUTPUT_NODE_ENTITY);if(m)try{m.remove();}catch{}const f=findFilter(ev.block);if(f)try{f.remove();}catch{}});
system.runInterval(()=>{for(const id of DIMENSION_IDS){const dim=world.getDimension(id);for(const m of dim.getEntities({type:OUTPUT_NODE_ENTITY})){const b=dim.getBlock({x:Math.floor(m.location.x),y:Math.floor(m.location.y),z:Math.floor(m.location.z)});if(b?.typeId!==OUTPUT_NODE_BLOCK){try{m.remove();}catch{}continue;}process(b);}}},INTERVAL);
