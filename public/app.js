const $=id=>document.getElementById(id);
const list=$('list'),inp=$('in'),ic=$('ic'),note=$('note');
const WAVE='<path d="M6 8v8M10 5v14M14 8v8M18 10v4"/>',SEND='<path d="M12 19V5M5 12l7-7 7 7"/>';
const ctx=$('ctx'),pal=$('pal'),palBtn=$('palBtn'),lvl=$('lvl');
const HI='Say hi to your friend 👋',PICK='Выбери подругу в меню 👋';
const ERR={bad_credentials:'Неверное имя или PIN',locked:'Слишком много попыток. Подожди 15 минут.',invalid_username:'Имя: только буквы, цифры, _ - +',invalid_display_name:'Введите имя',invalid_pin:'PIN: от 4 до 8 цифр',username_taken:'Такое имя уже есть'};
const errText=e=>ERR[e.message]||'Что-то пошло не так. Попробуй ещё раз.';
const enc=encodeURIComponent;
let me=null,myId=null,peer=null,members=[],msgs=[],editing=null,cur='#8b6cf0',hasMore=false,loadingOlder=false,ws=null,wsDelay=1000,wsTimer=null;

// ---- server ----
async function api(path,method='GET',body){
  const r=await fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>({}));
  if(r.ok)return data;
  if(r.status===401&&path!=='/api/login')showLogin();
  throw new Error(data.error||'server_error');
}
const view=m=>({id:m.id,from:m.sender,to:m.recipient,text:m.text});
function say(t){note.textContent=t;note.style.display='block';list.scrollTop=list.scrollHeight}

// ---- unread state, kept per browser ----
function readMap(){try{return JSON.parse(localStorage.getItem('read:'+myId)||'{}')}catch(_){return {}}}
function markRead(u,id){const r=readMap();if((r[u]||0)>=id)return;r[u]=id;try{localStorage.setItem('read:'+myId,JSON.stringify(r))}catch(_){}renderMembers()}
function isUnread(m,r){return m.lastMessageId>(r[m.username]||0)&&m.lastSender!==myId}

// ---- long-press menu ----
function hideCtx(){ctx.classList.remove('show')}
function copyText(t){function fb(){const a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(_){}a.remove()}try{navigator.clipboard.writeText(t).catch(fb)}catch(_){fb()}}
function hold(el,cb){
  let t=null,sx=0,sy=0;
  const cancel=()=>{if(t){clearTimeout(t);t=null}};
  el.addEventListener('pointerdown',e=>{el._held=false;sx=e.clientX;sy=e.clientY;t=setTimeout(()=>{t=null;el._held=true;cb()},500)});
  el.addEventListener('pointermove',e=>{if(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10)cancel()});
  ['pointerup','pointerleave','pointercancel'].forEach(n=>el.addEventListener(n,cancel));
  el.addEventListener('contextmenu',e=>e.preventDefault());
}
function fillCtx(items){ctx.innerHTML='';items.forEach(([n,f])=>{const a=document.createElement('a');a.textContent=n;a.onclick=()=>{hideCtx();f()};ctx.appendChild(a)});ctx.classList.add('show')}
function showCtx(el,x){
  const mine=x.from===myId;
  const items=[];
  if(mine)items.push(['Удалить',async()=>{try{await api('/api/messages/'+x.id,'DELETE');removeMsg(x.id)}catch(e){say(errText(e))}}]);
  items.push(['Скопировать',()=>copyText(x.text)]);
  if(mine)items.push(['Изменить',()=>{editing=x;inp.value=x.text;inp.placeholder='Изменить сообщение';ic.innerHTML=SEND;inp.focus()}]);
  fillCtx(items);
  const r=el.getBoundingClientRect(),w=ctx.offsetWidth,h=ctx.offsetHeight;
  let left=mine?r.right-w:r.left;left=Math.max(8,Math.min(left,innerWidth-w-8));
  let top=r.top-h-8;if(top<8)top=r.bottom+8;
  ctx.style.left=left+'px';ctx.style.top=top+'px';
}
document.addEventListener('pointerdown',e=>{if(!ctx.contains(e.target))hideCtx();if(!pal.contains(e.target)&&!palBtn.contains(e.target))pal.classList.remove('show')});

// ---- colours ----
function applyBg(){document.documentElement.style.setProperty('--bg','color-mix(in srgb,'+cur+' '+lvl.value+'%,#fff)')}
['#8b6cf0','#ec6fa8','#ff2a2a','#f5923e','#f2c230','#3fb67a','#2bb5b0','#3b82f6'].forEach((c,i)=>{
  const b=document.createElement('button');b.style.background=c;if(i===0)b.className='on';b.setAttribute('aria-label',c);
  b.onclick=()=>{pal.querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');cur=c;const s=document.documentElement.style;
    s.setProperty('--mine',c);s.setProperty('--btn',c);s.setProperty('--field','color-mix(in srgb,'+c+' 12%,#fff)');s.setProperty('--theirs','color-mix(in srgb,'+c+' 12%,#fff)');s.setProperty('--fg','#241a3a');s.setProperty('--theirsT','#241a3a');applyBg()};
  pal.appendChild(b)});
lvl.oninput=applyBg;
palBtn.onclick=()=>pal.classList.toggle('show');

// ---- messages ----
function render(keepScroll){
  list.querySelectorAll('.m').forEach(e=>e.remove());
  note.textContent=peer?HI:PICK;
  note.style.display=msgs.length?'none':'block';
  msgs.forEach(x=>{const d=document.createElement('div');d.className='m '+(x.from===myId?'me':'fr');d.textContent=x.text;hold(d,()=>showCtx(d,x));list.appendChild(d)});
  if(!keepScroll)list.scrollTop=list.scrollHeight;
}
function upsertMsg(m){
  const v=view(m),i=msgs.findIndex(x=>x.id===v.id);
  if(i>=0)msgs[i]=v;else{msgs.push(v);msgs.sort((a,b)=>a.id-b.id)}
  render(i>=0);
  if(!document.hidden)markRead(peer,v.id);
}
function removeMsg(id){const i=msgs.findIndex(x=>x.id===id);if(i>=0){msgs.splice(i,1);render(true)}}
async function loadChat(){
  const p=peer;
  const r=await api('/api/chats/'+enc(p)+'/messages');
  if(peer!==p)return;
  msgs=r.messages.map(view);hasMore=r.messages.length===100;render();
  if(msgs.length&&!document.hidden)markRead(p,msgs[msgs.length-1].id);
}
list.addEventListener('scroll',async()=>{
  if(list.scrollTop>0||!hasMore||loadingOlder||!peer||!msgs.length)return;
  loadingOlder=true;const p=peer;
  try{
    const r=await api('/api/chats/'+enc(p)+'/messages?before='+msgs[0].id);
    if(peer===p){const h=list.scrollHeight;msgs=r.messages.map(view).concat(msgs);hasMore=r.messages.length===100;render(true);list.scrollTop=list.scrollHeight-h}
  }catch(_){}
  loadingOlder=false;
});
inp.addEventListener('input',()=>{ic.innerHTML=inp.value.trim()?SEND:WAVE});
async function send(){
  const t=inp.value.trim();if(!t||!peer)return;
  inp.value='';ic.innerHTML=WAVE;
  const e=editing;
  try{
    if(e){editing=null;inp.placeholder='Сообщение';upsertMsg((await api('/api/messages/'+e.id,'PATCH',{text:t})).message);return}
    upsertMsg((await api('/api/chats/'+enc(peer)+'/messages','POST',{text:t})).message);
  }catch(err){inp.value=t;ic.innerHTML=SEND;if(e){editing=e;inp.placeholder='Изменить сообщение'}say('Не получилось отправить. Попробуй ещё раз.')}
}

// ---- voice control: looks only, nothing is recorded or sent yet ----
let rtimer=null,rsec=0;const fld=document.querySelector('.field');
let wvT=null,stream=null,an=null,ac=null,buf=null,hist=[];const BARS=30;
function wvTick(){const w=$('wv');let lv;if(an){an.getByteTimeDomainData(buf);let s=0;for(let i=0;i<buf.length;i++){const v=(buf[i]-128)/128;s+=v*v}lv=Math.min(1,Math.sqrt(s/buf.length)*4)}else lv=0.15+Math.random()*0.7;hist.push(lv);if(hist.length>BARS)hist.shift();[...w.children].forEach((el,i)=>{const v=hist[i-(BARS-hist.length)];el.style.height=(4+(v||0)*26)+'px'})}
function wvStart(){hist=[];const w=$('wv');w.innerHTML='';for(let i=0;i<BARS;i++)w.appendChild(document.createElement('i'));wvT=setInterval(wvTick,90);if(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{if(!wvT){s.getTracks().forEach(t=>t.stop());return}stream=s;ac=new (window.AudioContext||window.webkitAudioContext)();const src=ac.createMediaStreamSource(s);an=ac.createAnalyser();an.fftSize=256;buf=new Uint8Array(an.fftSize);src.connect(an)}).catch(()=>{})}
function wvStop(){clearInterval(wvT);wvT=null;try{if(stream)stream.getTracks().forEach(t=>t.stop())}catch(_){}try{if(ac)ac.close()}catch(_){}stream=null;ac=null;an=null}
function recStart(){rsec=0;$('rt').textContent='0:00';fld.classList.add('recing');ic.innerHTML=SEND;wvStart();rtimer=setInterval(()=>{rsec++;$('rt').textContent=Math.floor(rsec/60)+':'+String(rsec%60).padStart(2,'0')},1000)}
function recStop(){wvStop();clearInterval(rtimer);rtimer=null;fld.classList.remove('recing');ic.innerHTML=inp.value.trim()?SEND:WAVE}
$('mic').onclick=recStart;$('rc').onclick=recStop;
$('go').onclick=()=>{if(rtimer){recStop();return}send()};
inp.addEventListener('keydown',e=>{if(e.key==='Enter')send()});

// ---- menu and members ----
const closeMenu=()=>document.body.classList.remove('open');
$('menuBtn').onclick=()=>document.body.classList.add('open');
$('ov').onclick=closeMenu;
function renderMembers(){
  const box=$('members'),r=readMap();box.innerHTML='';let any=false;
  members.filter(m=>m.username!==myId).forEach(m=>{
    const el=document.createElement('div');el.className='ct';
    const b=document.createElement('b');b.textContent=m.displayName;
    if(isUnread(m,r)&&m.username!==peer){const u=document.createElement('span');u.className='un';b.appendChild(u);any=true}
    const p=document.createElement('div');p.className='ph';p.textContent=m.username;
    el.append(b,p);
    el.onclick=()=>{if(el._held){el._held=false;return}openChat(m.username)};
    if(me&&me.isAdmin)hold(el,()=>memberMenu(el,m));
    box.appendChild(el)});
  $('menuBtn').classList.toggle('has',any);
}
async function refreshMembers(){
  members=(await api('/api/members')).members;
  if(peer&&!members.some(m=>m.username===peer))closeChat();
  renderMembers();
}
function closeChat(){peer=null;msgs=[];hasMore=false;$('peer').textContent='';document.body.classList.remove('chatting');render()}
function openChat(u){
  const m=members.find(x=>x.username===u);if(!m)return;
  peer=u;msgs=[];hasMore=false;editing=null;inp.value='';inp.placeholder='Сообщение';ic.innerHTML=WAVE;
  $('peer').textContent=m.displayName;document.body.classList.add('chatting');closeMenu();render();renderMembers();
  loadChat().catch(()=>say('Не получилось загрузить чат.'));
}
async function refresh(){await refreshMembers();if(peer)await loadChat()}

// ---- administrator tools ----
const num=$('num');
function openForm(title,fields,onOk){
  $('formT').textContent=title;const box=$('formF');box.innerHTML='';$('formE').textContent='';
  const vals={};
  fields.forEach(f=>{const i=document.createElement('input');i.placeholder=f.ph;i.autocomplete='off';i.autocapitalize='off';if(f.digits)i.inputMode='numeric';vals[f.key]=i;box.appendChild(i)});
  $('save').onclick=async()=>{const o={};for(const k in vals)o[k]=vals[k].value;
    try{await onOk(o);num.classList.remove('show')}catch(e){$('formE').textContent=errText(e)}};
  num.classList.add('show');
}
num.addEventListener('click',e=>{if(e.target===num)num.classList.remove('show')});
const PINF={key:'pin',ph:'PIN (4-8 цифр)',digits:true};
$('addM').onclick=()=>{closeMenu();openForm('Новая участница',[{key:'username',ph:'Логин (имя, телефон или ID)'},{key:'displayName',ph:'Как показывать имя'},PINF],async o=>{await api('/api/admin/members','POST',o);await refreshMembers()})};
$('myPin').onclick=()=>{closeMenu();openForm('Мой новый PIN',[PINF],o=>api('/api/admin/members/'+enc(myId)+'/pin','POST',o).then(showLogin))};
function memberMenu(el,m){
  const place=()=>{const r=el.getBoundingClientRect(),w=ctx.offsetWidth,h=ctx.offsetHeight;ctx.style.left=Math.max(8,Math.min(r.left+16,innerWidth-w-8))+'px';let top=r.top-h-4;if(top<8)top=r.bottom+4;ctx.style.top=top+'px'};
  fillCtx([
    ['Новый PIN',()=>{closeMenu();openForm('Новый PIN: '+m.displayName,[PINF],o=>api('/api/admin/members/'+enc(m.username)+'/pin','POST',o))}],
    ['Удалить',()=>{fillCtx([['Точно удалить '+m.displayName+'? Чаты тоже исчезнут.',async()=>{try{await api('/api/admin/members/'+enc(m.username),'DELETE');await refreshMembers()}catch(e){say(errText(e))}}],['Отмена',()=>{}]]);place()}],
  ]);
  place();
}

// ---- live connection ----
function onEvent(e){
  if(e.type==='members.changed'){refreshMembers().catch(()=>{});return}
  if(e.type==='message.delete'){if(e.chatWith===peer)removeMsg(e.id);return}
  if(e.type==='message.new'||e.type==='message.edit'){
    const m=e.message,other=m.sender===myId?m.recipient:m.sender;
    if(other===peer)upsertMsg(m);
    if(e.type==='message.new'){const x=members.find(y=>y.username===other);if(x){x.lastMessageId=m.id;x.lastSender=m.sender;renderMembers()}}
  }
}
function openSocket(){
  if(!me||(ws&&ws.readyState<=1))return;
  clearTimeout(wsTimer);
  const s=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');ws=s;
  s.onopen=()=>{wsDelay=1000;refresh().catch(()=>{})};
  s.onmessage=e=>onEvent(JSON.parse(e.data));
  s.onclose=()=>{if(ws!==s||!me)return;ws=null;api('/api/me').catch(()=>{});wsTimer=setTimeout(openSocket,wsDelay);wsDelay=Math.min(wsDelay*2,30000)};
}
document.addEventListener('visibilitychange',()=>{if(document.hidden||!me)return;openSocket();refresh().catch(()=>{})});

// ---- sign-in ----
function showLogin(){
  me=null;myId=null;members=[];peer=null;msgs=[];hasMore=false;editing=null;clearTimeout(wsTimer);
  inp.value='';inp.placeholder='Сообщение';ic.innerHTML=WAVE;render();
  if(ws){const s=ws;ws=null;s.close()}
  closeMenu();num.classList.remove('show');document.body.classList.remove('chatting');
  $('peer').textContent='';$('admin').hidden=true;$('login').classList.add('show');
}
function start(member){
  me=member;myId=member.username;
  $('login').classList.remove('show');$('admin').hidden=!member.isAdmin;$('me').textContent=member.displayName;
  render();document.body.classList.add('open');
  refreshMembers().catch(()=>{});openSocket();
}
async function doLogin(){
  $('lE').textContent='';
  try{const r=await api('/api/login','POST',{username:$('lU').value,pin:$('lP').value});$('lP').value='';start(r.member)}
  catch(e){$('lE').textContent=errText(e)}
}
$('lGo').onclick=doLogin;
$('lP').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
$('logout').onclick=async()=>{try{await api('/api/logout','POST')}catch(_){}showLogin()};
fetch('/api/me').then(async r=>{if(r.ok)start((await r.json()).member);else showLogin()}).catch(showLogin);
