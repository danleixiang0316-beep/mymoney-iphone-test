'use strict';
const Phone=(()=>{
 const {core,identify,sha256}=PhoneRules;
 const database='MyMoney-Phone-V1';
 const blank=()=>({version:2,rulesVersion:core.RULES,revision:0,events:[]});
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
 function archive(events,book){
  const result=Object.create(null);let index=0;
  for(const event of events)if(event.kind==='review')result[event.id]=structuredClone(book.decisions[index++]);
  return result;
 }
 function verifyHistory(events,history){
  const reviewIds=events.filter(e=>e.kind==='review').map(e=>e.id).sort();
  if(!history||JSON.stringify(Object.keys(history).sort())!==JSON.stringify(reviewIds))throw Error('历史审核快照不完整，原数据已保留');
 }
 async function bookFor(a){
  if(a.version!==1&&a.version!==2)throw Error('账本版本无法识别，原数据已保留');
  if(a.version===2&&a.rulesVersion!==core.RULES)throw Error('计算规则版本无法识别，原数据已保留');
  if(a.history){
   if(a.version!==2||a.historyProof!==sha256(JSON.stringify({events:a.events,history:a.history})))throw Error('历史审核校验失败，原数据已保留');
   verifyHistory(a.events,a.history);
   return core.replay(a.events,a.history);
  }
  if(a.version===2&&a.events.length)throw Error('历史审核快照缺失，原数据已保留');
  const saved=await meta('derived'),b=core.replay(a.events);
  // Use the stored historical snapshot only when it belongs to these exact sources
  // and decisions. The ledger itself is allowed to differ after a rule correction.
  if(saved&&JSON.stringify(saved.records)===JSON.stringify(b.records)&&saved.decisions?.length===b.decisions.length&&
    saved.decisions.every((d,i)=>JSON.stringify(d.payload)===JSON.stringify(b.decisions[i].payload)&&d.created_at===b.decisions[i].created_at)){
   return core.replay(a.events,archive(a.events,saved));
  }
  // Without a matching stored snapshot or a verified legacy backup proof, the
  // engine can explain a recomputation but cannot claim what the user once saw.
  for(const d of b.decisions){d.historicalUnavailable=true;b.reliability[d.id]=false;}
  return b;
 }
 async function commit(kind,token,confirmed){
  const p=waiting.get(kind);
  if(confirmed!==true||!p||p.token!==token||p.expires<Date.now())throw Error('请重新预览并明确确认');
 const active=await read(),base=await bookFor(active);
 const historical=p.history||archive(active.events,base);
 const nextBook=core.replay(p.next,historical),derived=projection(nextBook);
 const savedHistory=archive(p.next,nextBook);
 const previousDerived=await meta('derived');
  await transaction('readwrite',(store,a)=>{
   if(a.revision!==p.revision)throw Error('本机账本已变化，请重新预览');
   if(kind==='restore')store.put(p.extra,'safety');
   if(kind!=='import'||a.events.length!==p.next.length){
    if(a.version===1){store.put({active:structuredClone(a),derived:previousDerived},'beforeUpgrade');}
    store.put({version:2,rulesVersion:core.RULES,revision:a.revision+1,events:p.next,history:savedHistory,
      historyProof:sha256(JSON.stringify({events:p.next,history:savedHistory}))},'active');
    store.put(derived,'derived');
   }
  });
  waiting.delete(kind);return {notice:'已经保存到本机账本。'};
 }
 function base64(bytes){
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
 }
 async function filesPreview(files,askCode){
  const request=++importRequest;waiting.delete('import');
 const a=await read(),book=await bookFor(a),before=core.state(book).ledger,next=[...a.events];
  const outcomes=[];let added=0,updates=0,duplicates=0;
  const group=crypto.randomUUID();
  for(const file of files){
   let diagnostic;
   try{
    const zipped=/\.zip$/i.test(file.name);
    if(!zipped&&!/\.csv$/i.test(file.name))throw Error('请选择支持的明细 CSV 或 ZIP；PDF、邮件、图片及工作簿暂不支持');
    if(file.size>(zipped?1100000:1000000))throw Error('文件超过大小限制');
    const original=new Uint8Array(await file.arrayBuffer());let bytes=original,filename=file.name;
    if(zipped){const item=await PhoneRules.zip.unpack(bytes,askCode && (()=>askCode(file.name)));bytes=item.bytes;filename=item.filename;}
    const {text,encoding}=PhoneRules.personal.decode(bytes);
    diagnostic=PhoneRules.format.diagnose(text,encoding);
    let body;
    const wallet=PhoneRules.cmb.format(text)?'bank':PhoneRules.alipay.section(text)?'alipay':PhoneRules.personal.headerOffset(text)?'wechat':null;
    if(wallet){
     body={filename,...(zipped?{archiveName:file.name}:{}),type:wallet,format:wallet+'-personal-v1',formatRevision:2,raw:base64(bytes)};
     if(zipped&&wallet!=='wechat')body.archiveRaw=base64(original);
    }else{
     if(zipped)throw Error('ZIP 中没有可识别的微信、支付宝或招行个人明细表头');
     if(encoding!=='utf-8')throw Error('编码或个人明细表头无法确认');
     let detected;try{detected=identify(text,sha256(text));}catch{throw Error('CSV 表头不认识，不能可靠确定来源或必要字段；未导入');}
     const {type,mapping}=detected;
     body={filename:file.name,text,type,mapping,virtual:true};
    }
    const event={id:crypto.randomUUID(),time:new Date().toISOString(),kind:'import',group,body,rulesVersion:core.RULES};
    const p=core.apply(book,event);
    if(p.errors.length)throw Error(p.errors.map(x=>'第 '+x.line+' 行：'+x.message).join('；'));
    if(!event.skip)next.push(event);added+=p.added;updates+=p.updates;duplicates+=p.duplicates;
    outcomes.push({name:file.name,ok:true});
   }catch(e){outcomes.push({name:file.name,ok:false,error:e.message,diagnostic});}
  }
  const q=core.queue(book),after=q.ledger;
  const months=[...new Set([before,after].flatMap(l=>[...l.payments,...l.events].map(x=>x.date.slice(0,7))))].sort();
  if(request!==importRequest)throw Error("选择已更新");
  return {token:outcomes.some(f=>f.ok)?preview('import',a.revision,next):null,added,updates,duplicates,pending:q.items.length,outcomes,
   months:months.map(month=>({month,before:core.summarize(before,month),after:core.summarize(after,month)}))};
 }
 async function api(path,body){
  if(path==='/api/reviews/commit')return commit('review',body.token,body.confirmed===true);
 const a=await read(),book=await bookFor(a);
  if(path==='/api/reviews')return {...core.queue(book),history:book.decisions,revision:a.revision};
  if(path==='/api/operations')return core.operations(book);
  if(path==='/api/reviews/preview'){
   const event={kind:'review',id:crypto.randomUUID(),time:new Date().toISOString(),body,rulesVersion:core.RULES};
   const result=core.apply(book,event);
   event.audit=structuredClone(book.decisions.at(-1));
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
 async function encryptBody(body,password){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:magic},await key(password,salt),enc.encode(JSON.stringify(body)));
  return new Blob([magic,salt,iv,cipher],{type:'application/octet-stream'});
 }
 async function seal(a,password){
  const book=await bookFor(a),history=archive(a.events,book);
  const body={app:'MyMoney-phone',schema:2,rules:core.RULES,revision:a.revision,events:a.events,history};
  body.proof=sha256(JSON.stringify({events:body.events,history:body.history}));
  return encryptBody(body,password);
 }
 async function upgradeBackup(password){
  const saved=await meta('beforeUpgrade');
  if(!saved?.active||!saved.derived)throw Error('没有可验证的升级前副本');
  const old=PhoneRules.legacy.core.replay(structuredClone(saved.active.events));
  const expected={...projection(old),ledger:PhoneRules.legacy.core.state(old).ledger};
  if(JSON.stringify(expected)!==JSON.stringify(saved.derived))throw Error('无法可靠确认旧版副本，原始副本已保留');
  return encryptBody({app:'MyMoney-phone',schema:1,rules:3,revision:saved.active.revision,events:saved.active.events,proof:sha256(JSON.stringify(expected))},password);
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
 if(restored.app!=='MyMoney-phone'||!Array.isArray(restored.events))throw Error('备份不兼容');
 let b;
 if(restored.schema===1&&restored.rules===3){
   let old;
   try{old=PhoneRules.legacy.core.replay(structuredClone(restored.events));}catch{}
   const oldProjection=old&&{...projection(old),ledger:PhoneRules.legacy.core.state(old).ledger};
   if(!oldProjection||sha256(JSON.stringify(oldProjection))!==restored.proof)throw Error('无法核实旧备份的历史规则，原账本已保留');
   b=core.replay(restored.events,archive(restored.events,old));
 }else if(restored.schema===2&&restored.rules===core.RULES&&restored.history){
   if(sha256(JSON.stringify({events:restored.events,history:restored.history}))!==restored.proof)throw Error('来源、关联或审核历史校验失败');
   verifyHistory(restored.events,restored.history);
   b=core.replay(restored.events,restored.history);
 }else throw Error('备份不兼容');
  const safety=await seal(a,password);
 const token=preview('restore',a.revision,restored.events,safety);waiting.get('restore').history=archive(restored.events,b);
 return {token,records:b.records.length,batches:b.batches.length,decisions:b.decisions.length};
 }
 return {read,meta,commit,api,filesPreview,backup,noteBackup,restorePreview,bookFor,upgradeBackup};
})();






