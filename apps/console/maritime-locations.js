import {exactPortName, portLookup, searchPortNames} from '../../services/maritime/schedule-collector/port-names.ts';

const countryNames=new Intl.DisplayNames(['zh-CN'],{type:'region'});
const countryLabel=code=>code?countryNames.of(code)||code:'国家 / 地区未提供';
export function locationLabel(candidate){
  const translated=exactPortName(candidate.name,candidate.country_code);
  return {text:candidate.name,zh:translated?.zh||'',en:candidate.name,country:candidate.country_code||'',id:candidate.carrier_location_id||''};
}
const cacheAge=24*60*60*1000;
export function readLocationCache(storage,key,now=Date.now()){
  try{
    const data=JSON.parse(storage?.getItem(key)||'[]');
    if(!Array.isArray(data))return [];
    return data.filter(row=>row&&typeof row.at==='number'&&row.at<=now&&now-row.at<cacheAge&&['text','zh','en','country','id'].every(k=>typeof row[k]==='string'&&row[k].length<=200)&&/^(?:[A-Z]{2})?$/u.test(row.country)).slice(0,60);
  }catch{return [];}
}
function browserStorage(){try{return typeof window==='undefined'?null:window.localStorage;}catch{return null;}}
export function createLocationPicker({api,esc,context,onPick,storage=browserStorage()}){
  let active=null,choices=[],selected=-1,timer=null,controller=null,generation=0,suppressFocus=false;
  const key=()=>{const c=context();return `freightclaw.schedule.ports.v1:${c.organization||'anonymous'}:${c.carrier}`;};
  const cancel=()=>{clearTimeout(timer);controller?.abort();controller=null;generation++;};
  function close(){cancel();if(active){const input=document.querySelector(`#live-${active}`);input?.setAttribute('aria-expanded','false');input?.removeAttribute('aria-activedescendant');const popup=document.querySelector(`#ports-${active}`);if(popup){popup.hidden=true;popup.innerHTML='';}}active=null;choices=[];selected=-1;}
  function render(side,rows,message=''){
    if(active!==side)return;
    choices=rows;selected=-1;
    const popup=document.querySelector(`#ports-${side}`),input=document.querySelector(`#live-${side}`);
    if(!popup||!input)return;
    popup.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');
    popup.innerHTML=`<div class="port-menu-heading">${rows.length?'请选择港口 / 城市':'港口 / 城市搜索'}</div><div role="listbox" id="port-list-${side}">${rows.map((row,index)=>`<button type="button" role="option" aria-selected="false" id="port-${side}-${index}" data-action="maritime-location-pick" data-side="${side}" data-index="${index}"><span><strong>${esc(row.zh||row.en)}</strong><small>${esc(row.en)}</small></span><span class="port-country">${esc(countryLabel(row.country))}</span></button>`).join('')}</div>${message?`<p class="port-menu-status" role="status">${esc(message)}</p>`:''}`;
  }
  function remember(rows){
    const merged=[...rows.map(row=>({...row,at:Date.now()})),...readLocationCache(storage,key())];
    const seen=new Set(),keep=merged.filter(row=>{const id=row.id+'|'+row.country;if(seen.has(id))return false;seen.add(id);return Boolean(row.id);}).slice(0,60);
    try{storage?.setItem(key(),JSON.stringify(keep));}catch{/* Storage limits do not block querying. */}
  }
  function show(input){
    const side=input.dataset.portSide;if(!side)return false;
    if(active&&active!==side)close();else cancel();
    active=side;const text=input.value.trim(),c=context();
    const cached=c.canQuery?readLocationCache(storage,key()).filter(row=>!text||[row.zh,row.en,countryLabel(row.country)].some(name=>name.toLocaleLowerCase().includes(text.toLocaleLowerCase()))):[];
    const local=searchPortNames(text).map(port=>({text:port.en,zh:port.zh,en:port.en,country:port.country,id:''}));
    const seen=new Set();const rows=[...cached,...local].filter(row=>{const id=(row.en.split(',')[0]||'').trim().toLocaleLowerCase()+'|'+row.country;if(seen.has(id))return false;seen.add(id);return true;}).slice(0,12);
    render(side,rows,rows.length?'':text?'继续输入港口中文名或英文名。':'输入港口中文名或英文名。');
    if(!c.canQuery||text.length<2)return true;
    const token=generation,lookup=portLookup(text,null);
    if(/\p{Script=Han}/u.test(lookup.text))return true;
    timer=setTimeout(async()=>{
      controller=new AbortController();
      try{
        const response=await api('/maritime/schedule-collector/locations',{method:'POST',acceptBusiness:true,signal:controller.signal,body:{carrier:c.carrier,text:lookup.text,country_code:lookup.countryCode}});
        if(token!==generation||active!==side)return;
        const candidates=response.data?.candidates|| (response.data?.resolved?[response.data.resolved]:[]);
        const official=candidates.map(locationLabel);remember(official);
        if(official.length)render(side,official.slice(0,20));
        else if(!rows.length)render(side,[],'未找到匹配港口，请换用其他名称。');
      }catch{if(token===generation&&!rows.length)render(side,[],'港口查询暂不可用，请稍后重试。');}
    },350);
    return true;
  }
  function pick(index){const row=choices[index],side=active;if(!row||!side)return;close();suppressFocus=true;try{onPick(side,row);document.querySelector(`#live-${side}`)?.focus();}finally{suppressFocus=false;}}
  return{
    field(side,value,country){const port=exactPortName(value,country);return `<div class="field port-field"><label for="live-${side}">${side==='origin'?'起运港 / 起运地':'目的港 / 目的地'}</label><input id="live-${side}" name="${side}" data-port-side="${side}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="port-list-${side}" autocomplete="off" value="${esc(value)}" required maxlength="200" placeholder="输入中文 / 英文港口名"><div class="port-selection">${port?esc(port.en.toUpperCase()+' · '+countryLabel(port.country)):''}</div><div id="ports-${side}" class="port-menu" hidden></div></div>`;},
    focus(event){if(suppressFocus)return false;if(event.target.dataset?.portSide)return show(event.target);if(!event.target.closest?.('.port-menu'))close();return false;},
    click(event){if(!event.target.closest?.('.port-field'))close();},
    input(event){if(event.isComposing)return false;return event.target.dataset?.portSide?show(event.target):false;},
    action(button){if(button.dataset.action!=='maritime-location-pick')return false;if(button.dataset.side===active)pick(Number(button.dataset.index));return true;},
    keydown(event){
      if(!active||event.isComposing||!event.target.dataset?.portSide)return false;
      if(event.key==='Escape'){event.preventDefault();close();return true;}
      if(event.key==='Tab'){close();return false;}
      if(event.key==='Enter'&&selected>=0){event.preventDefault();pick(selected);return true;}
      if(!['ArrowDown','ArrowUp'].includes(event.key)||!choices.length)return false;
      event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length;
      const input=document.querySelector(`#live-${active}`);input?.setAttribute('aria-activedescendant',`port-${active}-${selected}`);
      document.querySelectorAll(`#ports-${active} [role="option"]`).forEach((option,index)=>option.setAttribute('aria-selected',String(index===selected)));
      document.querySelector(`#port-${active}-${selected}`)?.scrollIntoView({block:'nearest'});
      return true;
    },reset:close,
  };
}
