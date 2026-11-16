'use strict';
const Phone=(()=>{
 const {core,identify,sha256}=PhoneRules;
 const database='MyMoney-Phone-V1';
 const blank=()=>({version:1,revision:0,events:[]});
 const waiting=new Map();
 let importRequest=0;
 function preview(kind,revision,next,extra){
  const token=crypto.randomUUID();waiting.set(kind,{token,revision,next,expires:Date.now()+900000,extra});return token;
 }
 async function open(){
  return new Promise((resolve,reject)=>{
   const req=indexedDB.open(database,1);
   req.onupgradeneeded=()=>req.result.createObjectStore('book');
   req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);
  });
 }
 async function transaction(mode,work){
  const db=await open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('book',mode),store=tx.objectStore('book');let result,error;
   const request=store.get('active');
   request.onsuccess=()=>{try{result=work(store,request.result||blank());}catch(e){error=e;tx.abort();}};
   tx.oncomplete=()=>{db.close();resolve(result);};
   tx.onabort=()=>{db.close();reject(error||tx.error||Error('保存中断，请重新预览'));};
  });
 }
 const read=()=>transaction('readonly',(_,a)=>a);
 function projection(book){
  return {records:book.records,batches:book.batches,sources:book.sources.map(({line,batchId,fingerprint})=>({line,batchId,fingerprint})),ledger:core.state(book).ledger,decisions:book.decisions};
 }
 async function commit(kind,token,confirmed){
  const p=waiting.get(kind);
  if(confirmed!==true||!p||p.token!==token||p.expires<Date.now())throw Error('请重新预览并明确确认');
  const derived=projection(core.replay(p.next));
  await transaction('readwrite',(store,a)=>{
   if(a.revision!==p.revision)throw Error('本机账本已变化，请重新预览');
   if(kind==='restore')store.put(p.extra,'safety');
   if(kind!=='import'||a.events.length!==p.next.length){
    store.put({version:1,revision:a.revision+1,events:p.next},'active');
    store.put(derived,'derived');
   }
  });
  waiting.delete(kind);return {notice:'已经保存到本机账本。'};
 }
 async function filesPreview(files){
  const request=++importRequest;waiting.delete('import');
  const a=await read(),book=core.replay(a.events),before=core.state(book).ledger,next=[...a.events];
  const outcomes=[];let added=0,updates=0,duplicates=0;
  const group=crypto.randomUUID();
  for(const file of files){
   try{
    const zipped=/\.zip$/i.test(file.name);
    if(!zipped&&!/\.csv$/i.test(file.name))throw Error('请选择微信账单 ZIP 或 CSV 文件');
    if(file.size>(zipped?1100000:1000000))throw Error('文件超过大小限制');
    let bytes=new Uint8Array(await file.arrayBuffer()),filename=file.name;
    if(zipped){const item=await PhoneRules.zip.unpack(bytes);bytes=item.bytes;filename=item.filename;}
    const {text,encoding}=PhoneRules.personal.decode(bytes);
    let body;
    if(PhoneRules.personal.headerOffset(text)){
     let binary='';
     for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
     body={filename,...(zipped?{archiveName:file.name}:{}),type:'wechat',format:'wechat-personal-v1',raw:btoa(binary)};
    }else{
     if(zipped)throw Error('ZIP 中没有可识别的微信个人账单表头');
     if(encoding!=='utf-8')throw Error('编码或微信个人明细表头无法确认');
     const {type,mapping}=identify(text,sha256(text));
     body={filename:file.name,text,type,mapping,virtual:true};
    }
    const event={id:crypto.randomUUID(),time:new Date().toISOString(),kind:'import',group,body};
    const p=core.apply(book,event);
    if(p.errors.length)throw Error(p.errors.map(x=>'第 '+x.line+' 行：'+x.message).join('；'));
    if(!event.skip)next.push(event);added+=p.added;updates+=p.updates;duplicates+=p.duplicates;
    outcomes.push({name:file.name,ok:true});
   }catch(e){outcomes.push({name:file.name,ok:false,error:e.message});}
  }
  const q=core.queue(book),after=q.ledger;
  const months=[...new Set([before,after].flatMap(l=>[...l.payments,...l.events].map(x=>x.date.slice(0,7))))].sort();
  if(request!==importRequest)throw Error("选择已更新");
  return {token:outcomes.some(f=>f.ok)?preview('import',a.revision,next):null,added,updates,duplicates,pending:q.items.length,outcomes,
   months:months.map(month=>({month,before:core.summarize(before,month),after:core.summarize(after,month)}))};
 }
 async function api(path,body){
  if(path==='/api/reviews/commit')return commit('review',body.token,body.confirmed===true);
  const a=await read(),book=core.replay(a.events);
  if(path==='/api/reviews')return {...core.queue(book),history:book.decisions,revision:a.revision};
  if(path==='/api/operations')return core.operations(book);
  if(path==='/api/reviews/preview'){
   const event={kind:'review',id:crypto.randomUUID(),time:new Date().toISOString(),body};
   const result=core.apply(book,event);
   return {...result,token:preview('review',a.revision,[...a.events,event])};
  }
  throw Error('未知本机操作');
 }
 async function meta(key){
  const db=await open();try{return await new Promise((resolve,reject)=>{
   const req=db.transaction('book').objectStore('book').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });}finally{db.close();}
 }
 const enc=new TextEncoder(),magic=enc.encode('MyMoney-Phone-Backup-v1\n');
 async function key(password,salt){
  if(!password||password.length<8)throw Error('请输入至少八个字符的备份口令');
  const material=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function seal(a,password){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const body={app:'MyMoney-phone',schema:1,rules:3,revision:a.revision,events:a.events,proof:sha256(JSON.stringify(projection(core.replay(a.events))))};
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:magic},await key(password,salt),enc.encode(JSON.stringify(body)));
  return new Blob([magic,salt,iv,cipher],{type:'application/octet-stream'});
 }
 async function backup(password){const a=await read();return {file:await seal(a,password),revision:a.revision};}
 async function noteBackup(revision){await transaction('readwrite',(store)=>store.put({time:new Date().toISOString(),revision},'backupTime'));}
 async function restorePreview(file,password){
  waiting.delete('restore');const a=await read(),data=new Uint8Array(await file.arrayBuffer()),n=magic.length;
  if(data.length<n+44||!magic.every((b,i)=>data[i]===b))throw Error('无法识别此备份版本');
  let restored;
  try{
   const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(n+16,n+28),additionalData:magic},await key(password,data.slice(n,n+16)),data.slice(n+28));
   restored=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  }catch{throw Error('口令错误或文件已损坏，未恢复');}
  if(restored.app!=='MyMoney-phone'||restored.schema!==1||restored.rules!==3||!Array.isArray(restored.events))throw Error('备份不兼容');
  const b=core.replay(restored.events);
  if(sha256(JSON.stringify(projection(b)))!==restored.proof)throw Error('来源、关联或审核历史校验失败');
  const safety=await seal(a,password);
  return {token:preview('restore',a.revision,restored.events,safety),records:b.records.length,batches:b.batches.length,decisions:b.decisions.length};
 }
 return {read,meta,commit,api,filesPreview,backup,noteBackup,restorePreview};
})();


