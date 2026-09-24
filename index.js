import { getSortedEntries } from '../../world-info.js';
const EXT = 'characterTiering';
const ctx = SillyTavern.getContext();

const defaults = {
  enabled: true,
  quietPrompts: false,
  recentMessages: 8,
  profiles: [],
  manualTiers: {},
  debug: false,
  worldBookSync: true,
};

function settings() {
  if (!ctx.extensionSettings[EXT]) ctx.extensionSettings[EXT] = structuredClone(defaults);
  const s = ctx.extensionSettings[EXT];
  for (const [k,v] of Object.entries(defaults)) if (s[k] === undefined) s[k] = structuredClone(v);
  return s;
}

function norm(v){ return String(v ?? '').trim().toLowerCase(); }
function namesOf(p){ return [p.name, ...(Array.isArray(p.aliases)?p.aliases:[])].filter(Boolean); }
function containsName(text,p){ const t=norm(text); return namesOf(p).some(n=>t.includes(norm(n))); }

function recentText(){
  const n=Math.max(1, Number(settings().recentMessages)||8);
  return (ctx.chat||[]).slice(-n).map(m=>m?.mes ?? m?.content ?? '').join('\n');
}

function autoTier(profile){
  const text=recentText();
  if (!containsName(text, profile)) return 0;
  const last=(ctx.chat||[]).slice(-2).map(m=>m?.mes ?? m?.content ?? '').join('\n');
  if (containsName(last, profile)) return 3;
  const presence=(profile.presence_keywords||['在场','来到','走进','身边','旁边','同行','一起']).some(k=>norm(text).includes(norm(k)));
  return presence ? 2 : 1;
}

function tierFor(p){
  const manual=settings().manualTiers?.[p.id||p.name];
  return Number.isInteger(manual) ? manual : autoTier(p);
}

function profileText(p,tier){
  const pick = tier>=3 ? (p.full||p.scene||p.short) : tier===2 ? (p.scene||p.short) : p.short;
  return pick ? `【${p.name}｜L${tier}】\n${pick}` : '';
}

function buildContext(){
  return settings().profiles.map(p=>[p,tierFor(p)])
    .filter(([,t])=>t>0)
    .sort((a,b)=>b[1]-a[1])
    .map(([p,t])=>profileText(p,t))
    .filter(Boolean).join('\n\n');
}

globalThis.CharacterTiering_interceptGeneration = function(chat,_contextSize,_abort,type){
  const s=settings();
  if(!s.enabled || (type==='quiet' && !s.quietPrompts)) return;
  const injected=buildContext();
  if(!injected) return;
  const content='[人物分级：当前人物资料。仅作为角色一致性参考，不覆盖更高优先级设定。]\n\n'+injected;
  if(Array.isArray(chat)){
    if(chat.length && 'role' in (chat[0]||{})) chat.unshift({role:'system',content});
    else chat.unshift({is_user:false,is_system:true,name:'人物分级',mes:content});
  }
  if(s.debug) console.debug('[Character Tiering] injected', content);
};

function el(tag, attrs={}, text=''){
  const x=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==='class') x.className=v;
    else if(k==='type') x.type=v;
    else x.setAttribute(k,v);
  }
  if(text) x.textContent=text;
  return x;
}

function save(){ ctx.saveSettingsDebounced(); renderProfiles(); }

function renderProfiles(){
  const box=document.getElementById('ct_profiles'); if(!box) return;
  box.innerHTML='';
  const s=settings();
  if(!s.profiles.length){ box.append(el('div',{class:'ct-muted'},'还没有人物。先在下方导入 JSON。')); return; }
  for(const p of s.profiles){
    const row=el('div',{class:'ct-row'});
    const left=el('div');
    left.append(el('b',{},p.name||'未命名'));
    left.append(el('div',{class:'ct-muted'},'自动等级：L'+autoTier(p)));
    const select=el('select',{class:'text_pole ct-tier'});
    const key=p.id||p.name;
    const cur=s.manualTiers[key];
    [['auto','自动'],['0','L0 无关'],['1','L1 相关'],['2','L2 在场'],['3','L3 焦点']].forEach(([v,label])=>{
      const o=el('option',{value:v},label);
      if((cur===undefined && v==='auto') || String(cur)===v) o.selected=true;
      select.append(o);
    });
    select.addEventListener('change',()=>{
      if(select.value==='auto') delete s.manualTiers[key];
      else s.manualTiers[key]=Number(select.value);
      ctx.saveSettingsDebounced(); renderProfiles();
    });
    row.append(left,select); box.append(row);
  }
}


function inferWorldBookProfile(entry){
  const keys=[...(Array.isArray(entry.key)?entry.key:[]), ...(Array.isArray(entry.keysecondary)?entry.keysecondary:[])].filter(Boolean);
  const memo=String(entry.comment||'').trim();
  const name=String(keys[0]||memo||'').trim();
  if(!name || !entry.content) return null;
  const content=String(entry.content).trim();
  const looksCharacter = /角色|人物|性格|外貌|说话|口癖|年龄|身高|服装|character|personality|appearance/i.test(content)
    || /角色|人物|character/i.test(memo);
  if(!looksCharacter) return null;
  const short = content.length>420 ? content.slice(0,420)+'…' : content;
  const scene = content.length>1200 ? content.slice(0,1200)+'…' : content;
  return {id:'wi:'+String(entry.uid??name),name,aliases:keys.slice(1),short,scene,full:content,source:'worldbook'};
}

async function syncWorldBook(showToast=true){
  try{
    const entries=await getSortedEntries();
    const imported=entries.map(inferWorldBookProfile).filter(Boolean);
    const manual=settings().profiles.filter(p=>p.source!=='worldbook');
    const byName=new Map();
    [...manual,...imported].forEach(p=>byName.set(norm(p.name),p));
    settings().profiles=[...byName.values()];
    ctx.saveSettingsDebounced(); renderProfiles();
    if(showToast) toastr?.success?.(`世界书同步完成：识别 ${imported.length} 个人物条目`);
    return imported.length;
  }catch(e){
    console.error('[Character Tiering] world book sync failed',e);
    if(showToast) toastr?.error?.('世界书同步失败：'+e.message);
    return 0;
  }
}

function importProfiles(text){
  let data=JSON.parse(text);
  if(!Array.isArray(data)) data=[data];
  const cleaned=data.filter(x=>x&&x.name).map((x,i)=>({
    id:String(x.id||x.name||i),
    name:String(x.name),
    aliases:Array.isArray(x.aliases)?x.aliases.map(String):[],
    short:String(x.short||''),
    scene:String(x.scene||x.short||''),
    full:String(x.full||x.scene||x.short||''),
    presence_keywords:Array.isArray(x.presence_keywords)?x.presence_keywords.map(String):undefined,
  }));
  settings().profiles=cleaned;
  settings().manualTiers={};
  ctx.saveSettingsDebounced(); renderProfiles();
  return cleaned.length;
}

function addSettings(){
  const host=document.getElementById('extensions_settings2')||document.getElementById('extensions_settings');
  if(!host || document.getElementById('ct_panel')) return;
  const panel=el('div',{id:'ct_panel',class:'inline-drawer'});
  const head=el('div',{class:'inline-drawer-toggle inline-drawer-header'});
  head.append(el('b',{},'人物分级 / Character Tiering'),el('div',{class:'inline-drawer-icon fa-solid fa-circle-chevron-down down'}));
  const body=el('div',{class:'inline-drawer-content'});

  const enabled=el('input',{type:'checkbox'}); enabled.checked=settings().enabled;
  enabled.addEventListener('change',()=>{settings().enabled=enabled.checked;ctx.saveSettingsDebounced();});
  const enabledLabel=el('label',{class:'checkbox_label'}); enabledLabel.append(enabled,el('span',{},'启用人物分级')); body.append(enabledLabel);

  body.append(el('div',{class:'ct-muted'},'L0 不注入；L1 短档；L2 在场档；L3 完整档。手动等级优先于自动判断。'));
  body.append(el('div',{id:'ct_profiles'}));

  const ta=el('textarea',{id:'ct_json',class:'text_pole',rows:'9',placeholder:'粘贴人物 JSON 数组…'});
  ta.value=JSON.stringify([{name:'示例角色',aliases:['示例'],short:'一句话核心设定',scene:'外貌、性格、当前互动需要的设定',full:'完整人物档案'}],null,2);
  body.append(ta);

  const actions=el('div',{class:'ct-actions'});
  const imp=el('button',{class:'menu_button'},'导入 / 覆盖人物');
  imp.addEventListener('click',()=>{try{const n=importProfiles(ta.value);toastr?.success?.(`已导入 ${n} 个人物`);}catch(e){toastr?.error?.('JSON 格式错误：'+e.message);}});
  const reset=el('button',{class:'menu_button'},'全部恢复自动');
  reset.addEventListener('click',()=>{settings().manualTiers={};save();});
  const sync=el('button',{class:'menu_button'},'从世界书同步');
  sync.addEventListener('click',()=>syncWorldBook(true));
  actions.append(imp,sync,reset); body.append(actions);

  const recent=el('input',{type:'number',class:'text_pole',min:'1',max:'50'}); recent.value=settings().recentMessages;
  recent.addEventListener('change',()=>{settings().recentMessages=Math.max(1,Number(recent.value)||8);ctx.saveSettingsDebounced();});
  const recentLabel=el('label'); recentLabel.append('自动判断读取最近消息数：',recent); body.append(recentLabel);

  const debug=el('input',{type:'checkbox'}); debug.checked=settings().debug;
  debug.addEventListener('change',()=>{settings().debug=debug.checked;ctx.saveSettingsDebounced();});
  const debugLabel=el('label',{class:'checkbox_label'}); debugLabel.append(debug,el('span',{},'控制台调试日志')); body.append(debugLabel);

  panel.append(head,body); host.append(panel); renderProfiles();
}

function init(){
  settings();
  addSettings();
  if(settings().worldBookSync) setTimeout(()=>syncWorldBook(false),800);
  console.info('[Character Tiering] v0.2.0 loaded');
}
init();
