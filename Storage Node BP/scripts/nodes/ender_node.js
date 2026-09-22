import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { findMarkerAtBlock } from "../core/marker.js";
import { moveBlockToEntity, moveContainerItems } from "../core/transfer.js";
import { getAdjacentContainers, getBlockContainer, getRoundRobinTargets, advanceRoundRobin } from "../core/container.js";
import { ENDER_NODE_BLOCK, ENDER_NODE_ENTITY } from "../config/constants.js";

export const ENDER_CHANNEL_PROPERTY = "ender_channel";
export const ENDER_TARGET_PROPERTY = "ender_target";
export const ENDER_REGISTRY_PROPERTY = "vfh:ender_nodes";
export const ENDER_CHANNEL_MAX_LENGTH = 32;
export const ENDER_MODE_PROPERTY = "ender_mode";
export const ENDER_MODE_SEND = "send";
export const ENDER_MODE_RECEIVE = "receive";

function normalizeChannel(value) { if (typeof value !== "string") return ""; return value.trim().slice(0, ENDER_CHANNEL_MAX_LENGTH); }
function normalizeCoordinate(value) { const n = Number(value); return Number.isFinite(n) ? Math.floor(n) : undefined; }
function normalizeEntry(entry) { if (!entry || typeof entry !== "object") return undefined; const dimension = typeof entry.dimension === "string" ? entry.dimension : ""; const x=normalizeCoordinate(entry.x), y=normalizeCoordinate(entry.y), z=normalizeCoordinate(entry.z); if (!dimension || x===undefined || y===undefined || z===undefined) return undefined; return { channel: normalizeChannel(entry.channel), dimension, x, y, z }; }
function entryKey(entry) { return `${entry.dimension}|${entry.x}|${entry.y}|${entry.z}`; }
function targetKey(entry) { const n=normalizeEntry(entry); return n ? entryKey(n) : ""; }

export function loadEnderRegistry() { try { const raw=world.getDynamicProperty(ENDER_REGISTRY_PROPERTY); if (typeof raw!=="string" || !raw) return []; const parsed=JSON.parse(raw); if (!Array.isArray(parsed)) return []; const unique=new Map(); for (const value of parsed) { const e=normalizeEntry(value); if (e) unique.set(entryKey(e),e); } return [...unique.values()]; } catch { return []; } }
export function saveEnderRegistry(entries) { const unique=new Map(); for (const value of Array.isArray(entries)?entries:[]) { const e=normalizeEntry(value); if (e) unique.set(entryKey(e),e); } world.setDynamicProperty(ENDER_REGISTRY_PROPERTY,JSON.stringify([...unique.values()])); }
export function getEnderChannel(marker) { try { return normalizeChannel(marker?.getDynamicProperty(ENDER_CHANNEL_PROPERTY)); } catch { return ""; } }
export function getEnderMode(marker) { try { const v=marker?.getDynamicProperty(ENDER_MODE_PROPERTY); return v===ENDER_MODE_SEND||v===ENDER_MODE_RECEIVE?v:ENDER_MODE_RECEIVE; } catch { return ENDER_MODE_RECEIVE; } }
export function setEnderMode(marker,value) { const mode=value===ENDER_MODE_SEND?ENDER_MODE_SEND:ENDER_MODE_RECEIVE; marker.setDynamicProperty(ENDER_MODE_PROPERTY,mode); if(mode===ENDER_MODE_RECEIVE)setEnderTarget(marker,""); return mode; }
export function getEnderTarget(marker) { try { const v=marker?.getDynamicProperty(ENDER_TARGET_PROPERTY); return typeof v==="string" ? v : ""; } catch { return ""; } }
export function setEnderTarget(marker,value) { const v=typeof value==="string" ? value : ""; marker.setDynamicProperty(ENDER_TARGET_PROPERTY,v); return v; }
export function setEnderChannel(marker,value) { const channel=normalizeChannel(value), old=getEnderChannel(marker); marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY,channel); if (channel!==old) setEnderTarget(marker,""); updateEnderRegistryAt(marker.dimension.id,marker.location,channel); return channel; }
export function updateEnderRegistryAt(dimensionId,location,channel="") { const e=normalizeEntry({channel,dimension:dimensionId,x:location.x,y:location.y,z:location.z}); if (!e) return false; const key=entryKey(e), registry=loadEnderRegistry().filter(v=>entryKey(v)!==key); registry.push(e); saveEnderRegistry(registry); return true; }
export function removeEnderRegistryAt(dimensionId,location) { const p=normalizeEntry({channel:"",dimension:dimensionId,x:location.x,y:location.y,z:location.z}); if (!p) return false; const key=entryKey(p),before=loadEnderRegistry(),after=before.filter(v=>entryKey(v)!==key); if(after.length===before.length)return false; saveEnderRegistry(after); return true; }
export function findEnderChannelEntries(channel,excludeDimensionId,excludeLocation) { const normalized=normalizeChannel(channel); if(!normalized)return[]; let excludeKey=""; if(excludeDimensionId&&excludeLocation){const self=normalizeEntry({channel:normalized,dimension:excludeDimensionId,x:excludeLocation.x,y:excludeLocation.y,z:excludeLocation.z});if(self)excludeKey=entryKey(self);} return loadEnderRegistry().filter(e=>e.channel===normalized&&(!excludeKey||entryKey(e)!==excludeKey)); }
export function findLinkedEnderEntries(marker){if(!marker)return[];return findEnderChannelEntries(getEnderChannel(marker),marker.dimension.id,marker.location);}
export function inspectEnderEntry(entry){const n=normalizeEntry(entry);if(!n)return{entry:undefined,loaded:false,blockPresent:false,markerPresent:false};try{const d=world.getDimension(n.dimension),l={x:n.x,y:n.y,z:n.z};if(!d.isChunkLoaded(l))return{entry:n,loaded:false,blockPresent:false,markerPresent:false};const b=d.getBlock(l),blockPresent=b?.typeId===ENDER_NODE_BLOCK,markerPresent=blockPresent?!!findMarkerAtBlock(b,ENDER_NODE_ENTITY):false;return{entry:n,loaded:true,blockPresent,markerPresent};}catch{return{entry:n,loaded:false,blockPresent:false,markerPresent:false};}}
export function inspectLinkedEnderNodes(marker){return findLinkedEnderEntries(marker).map(inspectEnderEntry);}

export function getRegisteredEnderChannels(){return [...new Set(loadEnderRegistry().map(e=>normalizeChannel(e.channel)).filter(Boolean))].sort((a,b)=>a.localeCompare(b));}


const ENDER_TICKING_PREFIX = "vfh_en";
function areaNum(v){const n=Math.floor(Number(v));return n<0?`m${-n}`:`${n}`;}
function areaDimTag(id){if(id==="minecraft:overworld")return "o";if(id==="minecraft:nether")return "n";if(id==="minecraft:the_end")return "e";return "x";}
export function enderTargetAreaName(entry){const n=normalizeEntry(entry);return n?`${ENDER_TICKING_PREFIX}_${areaDimTag(n.dimension)}_${areaNum(n.x)}_${areaNum(n.y)}_${areaNum(n.z)}`:"";}
function enderTargetAreaOptions(entry){const n=normalizeEntry(entry);if(!n)return undefined;const dimension=world.getDimension(n.dimension);const from={x:n.x,y:n.y,z:n.z};return {dimension,from,to:{...from}};}
export function removeEnderTargetArea(entry){const n=normalizeEntry(entry);if(!n)return {ok:false,error:"invalid target"};const name=enderTargetAreaName(n);try{const manager=world.tickingAreaManager;if(manager.hasTickingArea(name))manager.removeTickingArea(name);return {ok:true,name};}catch(err){return {ok:false,name,error:String(err?.message??err)};}}
export async function applyEnderTargetArea(entry){const n=normalizeEntry(entry);if(!n)return {ok:false,error:"invalid target"};const name=enderTargetAreaName(n);try{const manager=world.tickingAreaManager;const options=enderTargetAreaOptions(n);if(!options)return {ok:false,name,error:"invalid target options"};if(manager.hasTickingArea(name)){const area=manager.getTickingArea(name);if(area?.isFullyLoaded)return {ok:true,name,reused:true};manager.removeTickingArea(name);}if(!manager.hasCapacity(options))return {ok:false,name,error:"ticking area capacity exceeded"};await manager.createTickingArea(name,options);const area=manager.getTickingArea(name);return {ok:!!area?.isFullyLoaded,name,reused:false,error:area?.isFullyLoaded?"":"ticking area not fully loaded"};}catch(err){return {ok:false,name,error:String(err?.message??err)};}}
export async function ensureEnderTargetArea(marker){const target=getEnderTarget(marker);const entry=findEnderEntryByTargetKey(target);if(!entry)return {ok:false,error:"target not registered"};if(entry.channel!==getEnderChannel(marker))return {ok:false,error:"channel mismatch",entry};return {...await applyEnderTargetArea(entry),entry};}

export async function resolveEnderRemoteEndpoint(marker){
 const channel=getEnderChannel(marker);
 const target=getEnderTarget(marker);
 if(!marker)return {ok:false,reason:"source_marker_missing",channel:"",target:""};
 if(getEnderMode(marker)!==ENDER_MODE_SEND)return {ok:false,reason:"source_not_send",channel,target};
 if(!channel)return {ok:false,reason:"channel_empty",channel,target};
 if(!target)return {ok:false,reason:"target_empty",channel,target};
 const entry=findEnderEntryByTargetKey(target);
 if(!entry)return {ok:false,reason:"target_not_registered",channel,target};
 if(entry.channel!==channel)return {ok:false,reason:"channel_mismatch",channel,target,entry};
 const area=await applyEnderTargetArea(entry);
 if(!area.ok)return {ok:false,reason:"target_chunk_unavailable",channel,target,entry,area};
 try{
  const dimension=world.getDimension(entry.dimension);
  const location={x:entry.x,y:entry.y,z:entry.z};
  if(!dimension.isChunkLoaded(location))return {ok:false,reason:"target_chunk_not_loaded",channel,target,entry,area,dimension};
  const block=dimension.getBlock(location);
  if(!block||block.typeId!==ENDER_NODE_BLOCK)return {ok:false,reason:"target_block_missing",channel,target,entry,area,dimension,block};
  const targetMarker=findMarkerAtBlock(block,ENDER_NODE_ENTITY);
  if(!targetMarker)return {ok:false,reason:"target_marker_missing",channel,target,entry,area,dimension,block};
  if(getEnderChannel(targetMarker)!==channel)return {ok:false,reason:"target_marker_channel_mismatch",channel,target,entry,area,dimension,block,marker:targetMarker};
  if(getEnderMode(targetMarker)!==ENDER_MODE_RECEIVE)return {ok:false,reason:"target_not_receive",channel,target,entry,area,dimension,block,marker:targetMarker};
  return {ok:true,reason:"ok",channel,target,entry,area,dimension,block,marker:targetMarker};
 }catch(error){return {ok:false,reason:"endpoint_error",channel,target,entry,area,error:String(error?.message??error)};}
}

export async function transferEnderMarkerToRemoteMarker(marker,maxItems=1){
 const limit=Math.max(0,Math.floor(Number(maxItems))||0);
 if(!marker)return {ok:false,reason:"source_marker_missing",transferred:0};
 if(limit<=0)return {ok:false,reason:"invalid_max_items",transferred:0};
 const endpoint=await resolveEnderRemoteEndpoint(marker);
 if(!endpoint.ok)return {ok:false,reason:endpoint.reason,transferred:0,endpoint};
 if(endpoint.marker.id===marker.id)return {ok:false,reason:"same_marker",transferred:0,endpoint};
 try{
  const source=marker.getComponent("minecraft:inventory")?.container;
  if(!source||!source.isValid)return {ok:false,reason:"source_inventory_missing",transferred:0,endpoint};
  const target=endpoint.marker.getComponent("minecraft:inventory")?.container;
  if(!target||!target.isValid)return {ok:false,reason:"target_inventory_missing",transferred:0,endpoint};
  const transferred=moveContainerItems(source,target,limit);
  return {ok:true,reason:transferred>0?"transferred":"nothing_transferred",transferred,endpoint};
 }catch(error){return {ok:false,reason:"transfer_error",transferred:0,endpoint,error:String(error?.message??error)};}
}

const ENDER_PARTICLE_ID = "minecraft:end_chest";
const ENDER_PARTICLE_INTERVAL = 7;

export function spawnEnderNodeParticle(marker) {
 try {
  if (!marker) return false;
  const pos = {
   x: Math.floor(marker.location.x),
   y: Math.floor(marker.location.y),
   z: Math.floor(marker.location.z)
  };
  const block = marker.dimension.getBlock(pos);
  if (!block || block.typeId !== ENDER_NODE_BLOCK) return false;
  marker.dimension.spawnParticle(ENDER_PARTICLE_ID, {
   x: pos.x + 0.5,
   y: pos.y + 0.6,
   z: pos.z + 0.5
  });
  return true;
 } catch {
  return false;
 }
}

system.runInterval(() => {
 for (const dimensionId of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
  let dimension;
  try { dimension = world.getDimension(dimensionId); } catch { continue; }
  for (const marker of dimension.getEntities({ type: ENDER_NODE_ENTITY })) {
   spawnEnderNodeParticle(marker);
  }
 }
}, ENDER_PARTICLE_INTERVAL);

const ENDER_TRANSFER_AMOUNT=64;
const ENDER_PROCESS_INTERVAL=20;
const processingEnderMarkers=new Set();
export async function processEnderNode(marker,maxItems=ENDER_TRANSFER_AMOUNT){
 if(!marker)return {ok:false,reason:"source_marker_missing",localIn:0,remote:0,localOut:0};
 if(processingEnderMarkers.has(marker.id))return {ok:false,reason:"busy",localIn:0,remote:0,localOut:0};
 processingEnderMarkers.add(marker.id);
 try{
  const limit=Math.max(1,Math.floor(Number(maxItems))||ENDER_TRANSFER_AMOUNT);
  const pos={x:Math.floor(marker.location.x),y:Math.floor(marker.location.y),z:Math.floor(marker.location.z)};
  const block=marker.dimension.getBlock(pos);
  if(!block||block.typeId!==ENDER_NODE_BLOCK)return {ok:false,reason:"source_block_missing",localIn:0,remote:0,localOut:0};
  const inventory=marker.getComponent("minecraft:inventory")?.container;
  if(!inventory||!inventory.isValid)return {ok:false,reason:"source_inventory_missing",localIn:0,remote:0,localOut:0};
  const mode=getEnderMode(marker);
  if(mode===ENDER_MODE_RECEIVE){
   let localOut=0;
   const outputs=getAdjacentContainers(block,getBlockContainer,null,marker);
   for(const output of getRoundRobinTargets(marker,outputs)){
    const moved=moveContainerItems(inventory,output.container,limit-localOut);
    if(moved>0){localOut+=moved;advanceRoundRobin(marker,outputs,output);break;}
   }
   return {ok:true,reason:localOut>0?"local_out":"nothing_to_output",localIn:0,remote:0,localOut};
  }
  let localIn=0;
  const inputs=getAdjacentContainers(block,getBlockContainer,null,marker);
  for(const input of getRoundRobinTargets(marker,inputs)){
   const moved=moveContainerItems(input.container,inventory,limit-localIn);
   if(moved>0){localIn+=moved;advanceRoundRobin(marker,inputs,input);break;}
  }
  const remoteResult=await transferEnderMarkerToRemoteMarker(marker,limit);
  return {ok:remoteResult.ok,reason:remoteResult.reason,localIn,remote:remoteResult.transferred||0,localOut:0,endpoint:remoteResult.endpoint};
 }catch(error){return {ok:false,reason:"process_error",localIn:0,remote:0,localOut:0,error:String(error?.message??error)};}
 finally{processingEnderMarkers.delete(marker.id);}
}
system.runInterval(()=>{
 for(const dimensionId of ["minecraft:overworld","minecraft:nether","minecraft:the_end"]){
  let dimension;
  try{dimension=world.getDimension(dimensionId);}catch{continue;}
  for(const marker of dimension.getEntities({type:ENDER_NODE_ENTITY})){
   if(!getEnderChannel(marker))continue;
   if(getEnderMode(marker)===ENDER_MODE_SEND&&!getEnderTarget(marker))continue;
   processEnderNode(marker).catch(()=>{});
  }
 }
},ENDER_PROCESS_INTERVAL);

export function findEnderEntryByTargetKey(value){
 const key=typeof value==="string"?value:"";
 if(!key)return undefined;
 return loadEnderRegistry().find(entry=>targetKey(entry)===key);
}
function dimensionLabel(id){if(id==="minecraft:overworld")return "Overworld";if(id==="minecraft:nether")return "Nether";if(id==="minecraft:the_end")return "The End";return id;}
function targetLabel(entry){return `${dimensionLabel(entry.dimension)} : ${entry.x}, ${entry.y}, ${entry.z}`;}

async function showTargetSelector(player,marker,channel){
 const entries=findEnderChannelEntries(channel,marker.dimension.id,marker.location);
 if(entries.length===0){setEnderChannel(marker,channel);setEnderTarget(marker,"");player.sendMessage({translate:"vfh.ui.ender.no_targets"});return;}
 const currentTarget=getEnderChannel(marker)===channel?getEnderTarget(marker):"";
 const found=entries.findIndex(e=>targetKey(e)===currentTarget);
 const labels=entries.map(targetLabel);
 const response=await new ModalFormData().title({translate:"vfh.ui.ender.target_title"}).dropdown({translate:"vfh.ui.ender.target"},labels,{defaultValueIndex:found>=0?found:0}).submitButton({translate:"vfh.ui.common.save"}).show(player);
 if(response.canceled||!response.formValues)return;
 const selected=Number(response.formValues[0]??0), selectedEntry=entries[selected];
 const previousEntry=findEnderEntryByTargetKey(getEnderTarget(marker));
 setEnderChannel(marker,channel);setEnderTarget(marker,selectedEntry?targetKey(selectedEntry):"");
 if(previousEntry&&(!selectedEntry||targetKey(previousEntry)!==targetKey(selectedEntry)))removeEnderTargetArea(previousEntry);
 if(selectedEntry)await ensureEnderTargetArea(marker);
 player.sendMessage({translate:"vfh.ui.ender.saved"});
}

async function showRoleSelector(player,marker,channel){
 const current=getEnderMode(marker);
 const response=await new ModalFormData()
  .title({translate:"vfh.ui.ender.role_title"})
  .dropdown({translate:"vfh.ui.ender.role"},[{translate:"vfh.ui.ender.role.send"},{translate:"vfh.ui.ender.role.receive"}],{defaultValueIndex:current===ENDER_MODE_SEND?0:1})
  .submitButton({translate:"vfh.ui.common.save"}).show(player);
 if(response.canceled||!response.formValues)return;
 const mode=Number(response.formValues[0]??1)===0?ENDER_MODE_SEND:ENDER_MODE_RECEIVE;
 setEnderChannel(marker,channel);
 setEnderMode(marker,mode);
 if(mode===ENDER_MODE_SEND){await showTargetSelector(player,marker,channel);return;}
 setEnderTarget(marker,"");
 player.sendMessage({translate:"vfh.ui.ender.saved"});
}
async function showNewChannelForm(player,marker){
 const response=await new ModalFormData().title({translate:"vfh.ui.ender.new_channel_title"}).textField({translate:"vfh.ui.ender.channel"},{translate:"vfh.ui.ender.channel_placeholder"},{defaultValue:""}).submitButton({translate:"vfh.ui.ender.continue"}).show(player);
 if(response.canceled||!response.formValues)return;
 const channel=normalizeChannel(response.formValues[0]??""); if(!channel)return;
 setEnderChannel(marker,channel);
 await showRoleSelector(player,marker,channel);
}

async function showChannelSelector(player,marker){
 const channels=getRegisteredEnderChannels();
 const current=getEnderChannel(marker);
 const ordered=current&&channels.includes(current)?[current,...channels.filter(c=>c!==current)]:channels;
 const form=new ActionFormData().title({translate:"vfh.ui.ender.channel_selector_title"}).body({translate:"vfh.ui.ender.channel_selector_body"});
 for(const channel of ordered) form.button(channel);
 form.button({translate:"vfh.ui.ender.new_channel"});
 const response=await form.show(player); if(response.canceled||response.selection===undefined)return;
 if(response.selection===ordered.length){await showNewChannelForm(player,marker);return;}
 const channel=ordered[response.selection]; if(channel)await showRoleSelector(player,marker,channel);
}

const openingEnderForm=new Set();
world.beforeEvents.playerInteractWithBlock.subscribe(event=>{const player=event.player;if(!player.isSneaking||event.block.typeId!==ENDER_NODE_BLOCK||event.itemStack)return;const marker=findMarkerAtBlock(event.block,ENDER_NODE_ENTITY);if(!marker)return;event.cancel=true;const key=`${player.id}:${event.block.dimension.id}:${event.block.location.x}:${event.block.location.y}:${event.block.location.z}`;if(openingEnderForm.has(key))return;openingEnderForm.add(key);system.run(()=>{showChannelSelector(player,marker).catch(()=>{}).finally(()=>openingEnderForm.delete(key));});});
world.afterEvents.playerPlaceBlock.subscribe(event=>{const block=event.block;if(!block||block.typeId!==ENDER_NODE_BLOCK)return;let marker=findMarkerAtBlock(block,ENDER_NODE_ENTITY);if(!marker)marker=block.dimension.spawnEntity(ENDER_NODE_ENTITY,{x:block.location.x+0.5,y:block.location.y+0.5,z:block.location.z+0.5});if(marker.getDynamicProperty(ENDER_CHANNEL_PROPERTY)===undefined)marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY,"");if(marker.getDynamicProperty(ENDER_TARGET_PROPERTY)===undefined)marker.setDynamicProperty(ENDER_TARGET_PROPERTY,"");if(marker.getDynamicProperty(ENDER_MODE_PROPERTY)===undefined)marker.setDynamicProperty(ENDER_MODE_PROPERTY,ENDER_MODE_RECEIVE);updateEnderRegistryAt(block.dimension.id,block.location,getEnderChannel(marker));});
