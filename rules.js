'use strict';
const PhoneRules=(()=>{const factories={};const cache={};
factories["src/wechat-zip"]=function(module,load){
'use strict';
// Read one CSV into memory. Never extract paths to the filesystem.
async function unpack(bytes){
 const fail=message=>{throw Error(message);};
 if(bytes.length>1100000||bytes.length<22)fail('ZIP 大小超限或文件不完整');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const u16=i=>view.getUint16(i,true),u32=i=>view.getUint32(i,true);
 let end=bytes.length-22;
 const first=Math.max(0,end-65535);
 while(end>=first && !(u32(end)===0x06054b50 && end+22+u16(end+20)===bytes.length))end--;
 if(end<first)fail('ZIP 结尾无效或文件不完整');
 if(u16(end+4)||u16(end+6)||u16(end+8)!==1||u16(end+10)!==1)fail('只支持单卷且仅含一个 CSV 文件的 ZIP；多文件或重复条目不会导入');
 const central=u32(end+16);
 if(central+46>end||central+u32(end+12)!==end||u32(central)!==0x02014b50)fail('ZIP 目录损坏');
 const flags=u16(central+8),method=u16(central+10);
 if(flags&0x41||method===99)fail('暂不支持密码保护 ZIP。请在本机解压，再选择 CSV');
 if(flags&~0x0806 || ![0,8].includes(method))fail('不支持这种 ZIP 压缩方式或流式目录格式');
 const size=u32(central+24),packed=u32(central+20),crc=u32(central+16);
 if(!size||size>1000000||!packed||size>packed*200)fail('ZIP 展开体积或压缩比例超过限制');
 const namesize=u16(central+28);
 if(!namesize||namesize>500||central+46+namesize+u16(central+30)+u16(central+32)!==end||u16(central+34)||u32(central+42)!==0)fail('不支持分卷、隐藏条目或异常目录');
 const filetype=(u32(central+38)>>>16)&0xf000;
 if(filetype && filetype!==0x8000)fail('ZIP 内只接受普通文件');
 const encoded=bytes.subarray(central+46,central+46+namesize);
 let filename;
 try{filename=new TextDecoder('utf-8',{fatal:true}).decode(encoded);}
 catch{if(flags&0x800)fail('ZIP 文件名编码异常');try{filename=new TextDecoder('gb18030',{fatal:true}).decode(encoded);}catch{fail('ZIP 文件名编码异常');}}
 if(filename.length>200||filename.split('/').some(s=>!s||s==='.'||s==='..')||/[\\:\x00-\x1f\x7f]/.test(filename))fail('ZIP 文件路径不安全');
 if(!/\.csv$/i.test(filename))fail('ZIP 内须为微信个人账单 CSV；暂不支持工作簿或嵌套压缩包');
 if(central<30||u32(0)!==0x04034b50||u16(6)!==flags||u16(8)!==method||u32(14)!==crc||u32(18)!==packed||u32(22)!==size||u16(26)!==namesize)fail('ZIP 文件头与目录不符');
 const start=30+namesize+u16(28);
 if(start+packed!==central||!encoded.every((b,i)=>bytes[30+i]===b))fail('ZIP 文件边界或名称不一致');
 const payload=bytes.subarray(start,central);
 let output;
 if(method===0){if(size!==packed)fail('ZIP 长度错误');output=payload;}
 else{
  let decoder;
  try{decoder=new DecompressionStream('deflate-raw');}catch{fail('此浏览器不支持离线 Deflate 解压，请在本机解压后选择 CSV');}
  const reader=new Blob([payload]).stream().pipeThrough(decoder).getReader();
  output=new Uint8Array(size);
  let written=0;
  try{
   for(;;){const {value,done}=await reader.read();if(done)break;
    if(written+value.length>size){await reader.cancel();fail('ZIP 展开长度超限');}
    output.set(value,written);written+=value.length;
   }
  }catch{fail('ZIP 压缩数据损坏或展开长度超限');}
  if(written!==size)fail('ZIP 展开长度错误');
 }
 let check=0xffffffff;
 for(const b of output){check^=b;for(let i=0;i<8;i++)check=(check>>>1)^((check&1)?0xedb88320:0);}
 if(((check^0xffffffff)>>>0)!==crc)fail('ZIP 完整性校验失败');
 return {bytes:output,filename};
}
module.exports={unpack};

};
factories["src/wechat-personal"]=function(module,load){
'use strict';
const csv=load("public/csv");
const required=['交易时间','交易类型','交易对方','商品','收/支','金额(元)','支付方式','当前状态','交易单号','商户单号'];
function decode(bytes){
 if(bytes[0]===80&&bytes[1]===75||bytes[0]===208&&bytes[1]===207)throw Error('压缩包或 Excel 工作簿不能直接导入，请提供保留编号文本的 CSV');
 for(const encoding of ['utf-8','gb18030']){
  try{
   const text=new TextDecoder(encoding,{fatal:true,ignoreBOM:true}).decode(bytes);
   if(/[\u0000\uFFFD]/.test(text))break;
   return {text,encoding};
  }catch{if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)break;}
 }
 throw Error('编码异常，请检查原文件或另存为 UTF-8 CSV');
}
function headerOffset(text){
 const lines=text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/);
 // Inspect the first tabular line only; never skip transactions to find a later header.
 const i=lines.findIndex(line=>/^(?:"?交易时间"?|"?交易单号"?),/.test(line.trim()));
 if(i<0||!/(商户单号|金额[（(]元|收\/支)/.test(lines[i]))return null;
 if(i && !lines.slice(0,i).some(line=>line.includes('微信支付账单明细')))throw Error('无法核实微信明细前的说明行');
 if(lines.slice(0,i).some(line=>/^\s*"?\d{4}[-/]/.test(line)))throw Error('表头前出现交易行');
 return {i,table:lines.slice(i).join('\n')};
}
function parse(text){
 const section=headerOffset(text);
 if(!section)throw Error('缺少微信个人明细表头');
 const p=csv.parseCSV(section.table);
 const headers=p.headers.map(h=>h.replace('金额（元）','金额(元)').replace(/^商户订单号$/,'商户单号'));
 if(new Set(headers).size!==headers.length)throw Error('微信账单字段重复');
 for(const h of required)if(!headers.includes(h))throw Error('微信个人明细缺少字段：'+h);
 const records=[],errors=[];
 p.rows.forEach((cells,i)=>{
  const line=p.lineNumbers[i]+section.i;
  try{
   const get=k=>cells[headers.indexOf(k)].trim();
   const id=get('交易单号'),merchantId=get('商户单号'),time=get('交易时间'),direction=get('收/支'),status=get('当前状态'),nature=get('交易类型');
   const match=/^(\d{4}-\d\d-\d\d) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.exec(time);
   if(!match||new Date(match[1]+'T00:00:00Z').toJSON()?.slice(0,10)!==match[1])throw Error('交易时间无效');
   if(!/^[\w-]+$/.test(id)||/^[\d.]+e[+-]?\d+$/i.test(id))throw Error('交易单号缺失或已被表格软件改写');
   const money=/^[¥￥]?(\d{1,9})(?:\.(\d{1,2}))?$/.exec(get('金额(元)'));
   if(!money)throw Error('金额格式无效');
   const amount=Number(money[1])*100+Number((money[2]||'').padEnd(2,'0'));
   if(amount<=0)throw Error('金额须大于零');
   if(!['收入','支出','其他','中性交易','/','不计收支'].includes(direction))throw Error('收支方向无效');
   if(!status||!nature||!get('交易对方'))throw Error('交易状态、类型或交易对方缺失');
   const refund=/退款/.test(nature)&&direction!=='支出';
   const kind=refund?'退款':direction!=='支出'?'待识别':({'水电燃气缴费':'缴费','手机充值':'缴费','公共交通乘车':'即时消费','信用卡还款':'信用卡还款','零钱提现':'账户转账','零钱充值':'账户转账','转账':'对外转账','微信红包':'红包'})[nature]||'待识别';
   const value={transactionId:id,date:match[1],amount,merchant:get('交易对方'),account:get('支付方式'),kind,category:'未分类',paymentRef:'',platform:'',orderNo:'',evidence:['缴费','即时消费'].includes(kind)?nature:'',ruleVersion:3,
    paymentStatus:direction==='支出'&&['支付成功','已支付','交易成功'].includes(status)?'成功':'处理中',
    statementTime:time,merchantBillNo:merchantId,statementDirection:direction,statementStatus:status,statementKind:nature,product:get('商品')};
   if(refund){value.returnStatus=status==='退款成功'?'成功':'申请中';if(value.returnStatus==='成功')value.statusEvidence=status;}
   records.push({type:'wechat',line,value});
  }catch(e){errors.push({line,message:e.message});}
 });
 return {records,errors};
}
module.exports={decode,parse,headerOffset};


};
factories["src/event-book"]=function(module,load){
'use strict';
const personal=load("src/wechat-personal");
const csv=load("public/csv");
const imports=load("src/import-ledger");
const reviews=load("src/review-engine");
const history=load("src/operation-history");
const {createHash}=load("phone-src/hash");
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw Error(message);};
const {keyOf,summarize}=imports;
const bytes=x=>new TextEncoder().encode(x).length;
const empty=()=>({records:[],seen:new Set(),keys:new Set(),batches:[],sources:[],decisions:[]});
const state=b=>reviews.reviewedLedger(b.records,b.decisions);
const queue=b=>reviews.queue(b.records,b.decisions,b.sources);
const operations=b=>b.decisions.map(r=>({...r,time:r.created_at,targetId:r.payload.targetId,blocked:history.conflict(b.records,b.decisions,r)})).reverse();

function importFile(book,body,event){
  const {type,filename,mapping}=body;
 const official=body.format==='wechat-personal-v1';
 let text=body.text;
 if(official){
  if(type!=='wechat'||typeof body.raw!=='string'||body.raw.length>1333336)fail('原始微信文件无效');
  const bytes=Uint8Array.from(atob(body.raw),c=>c.charCodeAt(0));
  if(bytes.length>1000000)fail('文件超过 1 MB');
  text=personal.decode(bytes).text;
 }
 if((!official&&body.virtual!==true)||typeof text!=='string'||(!official&&bytes(text)>1000000)||typeof filename!=='string'||filename.length>200||!filename.toLowerCase().endsWith('.csv'))fail('请选择 1 MB 以内的虚拟 CSV');
 const n=official?personal.parse(text):csv.normalize(text,type,mapping||csv.autoMap(type,csv.parseCSV(text).headers));
 let added=0,updates=0,duplicates=0;
 if(!n.errors.length){
  const digest=hash(JSON.stringify(official?[body.format,body.raw]:[text,mapping||null]));
  const same=book.batches.some(b=>b.source===type&&b.digest===digest);
  if(!same)book.batches.push({id:event.id,created_at:event.time,source:type,filename,digest});
  for(const r of n.records){
   const fp=reviews.fingerprint(r),key=keyOf(r);
   if(!same)book.sources.push({batchId:event.id,created_at:event.time,filename,source:type,original_csv:text,line:r.line,fingerprint:fp});
   if(book.seen.has(fp)){duplicates++;continue;}
   if(book.keys.has(key))updates++;else added++;
   book.keys.add(key);book.seen.add(fp);book.records.push(r);
  }
  event.skip=same;
 }
 return {rows:n.records.map(r=>({line:r.line,...r.value})),added,updates,duplicates,errors:n.errors,canCommit:!n.errors.length};
}
function decide(book,event){
 const before=state(book),{records,decisions}=book,body=event.body;
 const payload=history.controls.has(body.action)?history.control(records,decisions,body):reviews.decide(records,body);
 payload.contextHash=history.context(records,payload).hash;
 const scope=s=>({effectiveRecords:s.effectiveRecords.filter(r=>[payload.entityKey,payload.peerKey].includes(keyOf(r))),ledger:s.ledger});
 const row={id:decisions.length+1,entity_key:payload.entityKey,created_at:event.time,reason:payload.reason,action:payload.action,payload,before:scope(before)};
 decisions.push(row);const after=state(book);row.after=scope(after);
 const changes=[...new Set([...before.ledger.events,...after.ledger.events,...before.ledger.payments].map(x=>x.date.slice(0,7)))].sort().map(month=>({month,before:summarize(before.ledger,month).totalExpense,after:summarize(after.ledger,month).totalExpense}));
 return {entityKey:payload.entityKey,before:row.before,after:row.after,changes,notice:'请核对依据和账本变化。'};
}
function apply(book,event){
 if(event.kind==='review')return decide(book,event);
 if(event.kind==='import')return importFile(book,event.body,event);
 fail('未知操作类型');
}
function replay(events){
 const book=empty(),ids=new Set();
 for(const e of events){
  if(!e||typeof e.id!=='string'||ids.has(e.id)||!Number.isFinite(Date.parse(e.time)))fail('操作序列无效');
  ids.add(e.id);const result=apply(book,e);if(result.errors?.length||e.skip)fail('备份含无效或重复的导入事件');
 }
 return book;
}

module.exports={empty,state,queue,operations,apply,replay,summarize,bytes};


};
factories["src/import-ledger"]=function(module,load){
'use strict';
const {buildLedger,summarize}=load("public/ledger");
const {applyExpenseRules,resolvePaymentVersions}=load("src/expense-rules");
const keyOf=r=>r.type==='orders'?JSON.stringify(['orders',r.value.platform,r.value.orderNo,r.value.itemId]):JSON.stringify([r.type,r.value.transactionId]);
const orderId=r=>JSON.stringify([r.platform,r.orderNo]);
function makeLedger(records){
 const review=[], input={payments:[],orders:[],links:[],receipts:[],refunds:[]};
 const groups=new Map();for(const r of records){const k=keyOf(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 const orderGroups=new Map(), withheld=new Set();
 for(const [id,versions]of groups){
   const first=versions[0];let r=first.value;
   if(first.type!=='orders'){
     const resolved=resolvePaymentVersions(versions.map(x=>x.value));r=resolved.value;
     const conflict=resolved.conflict;
     if(conflict)review.push({id,reason:'同一来源流水号内容冲突：保留全部原始版本，暂不确认或关联'});
     const shopping=!!r.orderNo||['购物','外卖'].includes(r.kind)||/拼多多|抖音|淘宝|京东|美团|饿了么/.test(r.merchant);
     input.payments.push({id,date:r.date,amount:r.amount,merchant:r.merchant,account:r.account,channel:{wechat:'微信',alipay:'支付宝',bank:'银行卡'}[first.type],sourceType:first.type,category:r.category,evidence:r.evidence,kind:conflict||shopping?undefined:({'即时消费':'instant','账户转账':'transfer','信用卡还款':'repayment'}[r.kind]),raw:r,conflict,shopping});
   }else{
     const stable=x=>JSON.stringify([x.platform,x.orderNo,x.itemId,x.name,x.amount,x.date,x.paymentRef,x.category,x.orderKind||'']);
     const food=r.orderKind==='外卖'||['美团','饿了么'].includes(r.platform);
     const confirms=versions.filter(x=>x.value.status===(food?'订单已完成':'已确认收货'));
     const conflict=versions.some(x=>stable(x.value)!==stable(r))||new Set(confirms.map(x=>x.value.receiptDate)).size>1;
     const oid=orderId(r);
     if(!orderGroups.has(oid))orderGroups.set(oid,[]);
     orderGroups.get(oid).push({value:r,receipt:confirms[0]?.value,conflict});
     if(conflict){withheld.add(oid);review.push({id:oid,reason:'订单金额、关联号、确认日期等内容冲突：不自动覆盖，保留版本待审核'});}
   }
 }
 for(const [id,items]of orderGroups){const r=items[0].value;
   const incompatible=items.some(i=>i.value.paymentRef!==r.paymentRef||i.value.date!==r.date);
   if(incompatible){withheld.add(id);review.push({id,reason:'同一订单不同明细的付款信息不一致'});}
   input.orders.push({id,platform:r.platform,paid:items.reduce((s,x)=>s+x.value.amount,0),category:r.category,raw:r,items:items.map(x=>({id:x.value.itemId,name:x.value.name,amount:x.value.amount}))});
 }
 // 资金关联号必须是文件明确提供的同一资金事件证据；金额、日期、账户须一致。
 load("src/payment-groups").paymentGroups(input.payments,review);
 for(let i=0;i<input.payments.length;i++)for(let j=i+1;j<input.payments.length;j++){
   const a=input.payments[i],b=input.payments[j];
   if((!a.economicId || a.economicId!==b.economicId) && (!a.raw.paymentRef||!b.raw.paymentRef)&&a.date===b.date&&a.amount===b.amount&&a.account===b.account&&a.merchant===b.merchant){
     a.kind=b.kind=undefined;a.conflict=b.conflict=true;
     review.push({id:a.id+' / '+b.id,reason:'金额、日期、账户及商户相同，但缺少可靠共同关联号，疑似重复；保留两条资金流水，暂不确认消费或合并'});
   }
 }
 const nonShopping=new Set(input.payments.filter(p=>['信用卡还款','账户转账','退款','退回款','红包','对外转账'].includes(p.raw.kind)).map(p=>p.economicId||p.id));
 for(const p of input.payments){
   const candidates=input.orders.filter(o=>(p.raw.paymentRef&&o.raw.paymentRef===p.raw.paymentRef)||(p.raw.orderNo&&orderId(p.raw)===o.id));
   if(candidates.length){p.kind=undefined;for(const o of candidates){
     const valid=!nonShopping.has(p.economicId||p.id)&&!p.conflict&&!withheld.has(o.id)&&candidates.length===1&&p.raw.evidence&&o.raw.evidence&&p.raw.paymentRef&&p.raw.paymentRef===o.raw.paymentRef&&p.amount===o.paid&&p.date===o.raw.date&&(!p.raw.orderNo||orderId(p.raw)===o.id);
     input.links.push({paymentId:p.id,orderId:o.id,reliable:!!valid,evidence:valid?'CSV 明确资金关联号、金额、付款日期及订单号一致':'候选关联，需要人工审核'});
   }}
 }
 for(const o of input.orders){
   const links=input.links.filter(l=>l.orderId===o.id);
   if(!links.some(l=>l.reliable)||links.some(l=>!l.reliable)){
     withheld.add(o.id);review.push({id:o.id,reason:'订单尚无唯一可靠支付关联，或存在冲突候选；暂不确认消费'});
     for(const l of links)l.reliable=false;
   }
   if(!withheld.has(o.id))for(const item of orderGroups.get(o.id))if(item.receipt)input.receipts.push({id:o.id+':'+item.value.itemId,orderId:o.id,itemId:item.value.itemId,date:item.receipt.receiptDate,status:'已确认收货',reliable:true,evidence:item.receipt.evidence});
 }
 // 未有订单文件的购物提示和未识别付款均保留资金流出，不能当作即时消费。
 const ledger=buildLedger(input);
 applyExpenseRules(input,ledger);
 for(const p of ledger.payments)if(p.status==='待识别'&&p.shopping)p.status='购物待关联';
 ledger.review.push(...review);
 ledger.review=[...new Map(ledger.review.map(r=>[r.id+'|'+r.reason,r])).values()];
 return {input,ledger};
}
module.exports={keyOf,makeLedger,summarize};

};
factories["src/payment-groups"]=function(module,load){
'use strict';

const walletType = new Map([['微信','wechat'],['支付宝','alipay']]);

// Keep the identifiers from each statement intact. The separate group key is
// only used to build the derived ledger, and is recalculated on every import.
function paymentGroups(payments, review) {
 const byId = new Map(payments.map(p => [p.id, p]));
 const groups = new Map();
 const keys = new Map(payments.filter(p => p.raw.paymentRef)
   .map(p => [p.id, 'reference:' + p.raw.paymentRef]));
 const ambiguous = new Set();
 for (const bank of payments.filter(p => p.sourceType === 'bank' && p.raw.walletTransactionId)) {
  const walletId = JSON.stringify([walletType.get(bank.raw.walletChannel), bank.raw.walletTransactionId]);
  const wallet = byId.get(walletId);
  if (!wallet) {
   bank.conflict = true;
   review.push({id:bank.id,reason:'银行引用的钱包流水尚未导入，暂不确认支出'});
   continue;
  }
  const references = new Set([wallet.raw.paymentRef, bank.raw.paymentRef].filter(Boolean));
  if (references.size > 1) {
   wallet.conflict = bank.conflict = true;
   review.push({id:wallet.id+' / '+bank.id,reason:'银行引用的钱包流水与原始资金关联号冲突'});
   continue;
  }
  const key = references.size ? 'reference:' + [...references][0] : 'wallet:' + wallet.id;
  if (keys.has(wallet.id) && keys.get(wallet.id)!==key) ambiguous.add(wallet.id);
  keys.set(wallet.id,key);
  keys.set(bank.id,key);
 }
 for(const bank of payments.filter(p=>p.sourceType==='bank'&&p.raw.walletChannel&&!p.raw.walletTransactionId&&!p.raw.paymentRef)){
  if(['信用卡还款','账户转账'].includes(bank.raw.kind))continue;
  bank.conflict=true;
  review.push({id:bank.id,reason:'银行账单注明钱包渠道，但没有对应流水号或共同资金关联号'});
  for(const wallet of payments.filter(p=>p.sourceType===walletType.get(bank.raw.walletChannel)&&p.date===bank.date&&p.account===bank.account&&p.amount===bank.amount)){
   wallet.conflict=true;
   review.push({id:wallet.id,reason:'同渠道、日期、账户和金额有银行候选扣款，缺少唯一流水依据，未合并'});
  }
 }
 for (const p of payments) {
  if (ambiguous.has(p.id) || ambiguous.has(JSON.stringify([walletType.get(p.raw.walletChannel),p.raw.walletTransactionId])) || p.raw.reviewLinkDisputed) p.conflict = true;
  const key = keys.get(p.id);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key,[]);
  groups.get(key).push(p);
 }
 for (const [key,rows] of groups) {
  const first=rows[0];
  const unique = fn => new Set(rows.map(fn).filter(Boolean));
  const sourceTypes=unique(p=>p.sourceType);
  const kinds=unique(p=>{
   const kind=p.raw.kind;
   if(kind==='待识别')return '';
   if(p.shopping && ['即时消费','购物'].includes(kind))return '购物';
   return kind;
  });
  const claimedChannels=unique(p=>p.raw.walletChannel);
  const channelConflict=claimedChannels.size>1 || [...claimedChannels].some(c=>[...sourceTypes].some(t=>t!=='bank'&&t!==walletType.get(c)));
  const multipleWallets=sourceTypes.has('wechat') && sourceTypes.has('alipay');
  const manuallyApproved=first.raw.paymentRef && rows.every(p=>p.raw.reviewDuplicateApproved===first.raw.paymentRef);
  const valid=rows.every(p=>!p.conflict && p.evidence && p.amount===first.amount && p.date===first.date && p.account===first.account)
    && !channelConflict && !multipleWallets && kinds.size<=1
    && unique(p=>p.raw.orderNo && JSON.stringify([p.raw.platform,p.raw.orderNo])).size<=1
    && unique(p=>p.raw.originalRef).size<=1
    && unique(p=>p.raw.returnStatus==='成功' && (p.raw.completedAt||p.date)).size<=1
    && (sourceTypes.size===rows.length || manuallyApproved);
  if(valid){for(const p of rows)p.economicId=key;}
  else if(rows.length>1){
   for(const p of rows){p.conflict=true;p.kind=undefined;}
   review.push({id:rows.map(p=>p.id).join(' / '),reason:'资金关联的渠道、账户、日期、金额、订单、性质或凭证有冲突，未合并'});
  }
 }
}
module.exports={paymentGroups};

};
factories["src/expense-rules"]=function(module,load){
'use strict';
const incoming=r=>['退款','退回款'].includes(r.kind);
const paymentStable=r=>JSON.stringify([r.transactionId,r.date,r.amount,r.merchant,r.account,r.kind,r.category,r.paymentRef,r.platform,r.orderNo,r.recipient||'',r.ownership||'',r.originalRef||'',r.targetItemId||'',r.walletChannel||'',r.walletTransactionId||'',r.statementDirection||'',r.merchantBillNo||'',r.statementTime||'']);
function resolvePaymentVersions(rows){
 const conflict=rows.some(r=>paymentStable(r)!==paymentStable(rows[0]));
 const successful=rows.filter(r=>['已领取','已收款'].includes(r.completionStatus));
 const dates=new Set(successful.map(r=>r.completedAt||''));
 const done=rows.filter(r=>r.returnStatus==='成功');
 const rank=r=>r.returnStatus==='成功'?5:['已领取','已收款'].includes(r.completionStatus)?4:r.completionStatus==='已退回'?3:r.paymentStatus==='成功'?2:1;
 const selected=[...rows].sort((a,b)=>rank(b)-rank(a))[0];
 return {value:{...selected,...(successful[0]?{completionStatus:successful[0].completionStatus,completedAt:successful[0].completedAt,statusEvidence:successful[0].statusEvidence}:{}),returnNoted:rows.some(r=>r.completionStatus==='已退回')},conflict:conflict||dates.size>1||new Set(done.map(r=>r.completedAt||r.date)).size>1||rows.some(r=>r.paymentStatus==='失败')&&rows.some(r=>r.paymentStatus==='成功')};
}
function applyExpenseRules(input,ledger){
 const review=(id,reason)=>ledger.review.push({id,reason});
 const event=(id,date,amount,category,source,reason)=>ledger.events.push({id,date,amount,category,source,reason});
 // 旧版 CSV 的合同仅包含已扣款流水；新增字段模板必须明确给出成功状态。
 const legacyPosted=r=>!r.ruleVersion&&['','即时消费','购物','待识别','账户转账','信用卡还款'].includes(r.kind||'');
 const posted=r=>r.paymentStatus==='成功'||legacyPosted(r);
 const groups=new Map();for(const p of input.payments){const k=p.economicId||p.id;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);}
 const incomingGroups=[];
 for(const p of ledger.payments){
   const sources=groups.get(p.id)||[p],specific=sources.filter(s=>!['待识别',''].includes(s.raw.kind||''));
   let chosen=specific[0]||sources[0];
   // 同一资金事件中银行记录可只提供扣款；平台记录提供交易性质和完成状态。
   const signatures=new Set(specific.map(s=>JSON.stringify([s.shopping?'购物':s.raw.kind,s.raw.recipient||'',s.raw.ownership||'',incoming(s.raw)?s.raw.originalRef||'':'',s.raw.targetItemId||''])));
   const successful=sources.filter(s=>s.raw.kind===chosen.raw.kind&&['已收款','已领取'].includes(s.raw.completionStatus));
   const conflict=sources.some(s=>s.conflict)||signatures.size>1||(sources.some(s=>s.raw.paymentStatus==='成功')&&sources.some(s=>s.raw.paymentStatus==='失败'))||new Set(successful.map(s=>s.raw.completedAt||'')).size>1;
   if(successful.length)chosen=successful[0];
   if(incoming(chosen.raw))chosen=sources.find(s=>s.raw.returnStatus==='成功'&&s.raw.statusEvidence)||chosen;
   if(sources.some(s=>s.shopping))p.shopping=true;
   p.raw={...chosen.raw,returnNoted:sources.some(s=>s.raw.returnNoted)};p.recipient=p.raw.recipient||p.merchant;p.ownership=p.raw.ownership||'未知';p.nature=p.raw.kind||'待识别';p.fundsPosted=sources.some(s=>posted(s.raw));
   if(p.raw.kind==='退款'||p.raw.kind==='退回款'){incomingGroups.push({payment:p,sources,conflict});p.direction='in';p.fundsPosted=p.raw.returnStatus==='成功'&&!!p.raw.statusEvidence;p.status=p.fundsPosted?'回款已成功':'回款待确认';}
   else p.direction='out';
   // 重新应用支出规则，避免旧即时消费或含糊转账标签提前入账。
   ledger.events=ledger.events.filter(e=>e.source!==p.id);
   ledger.review=ledger.review.filter(r=>r.id!==p.id||!r.reason.includes('无法确定'));
   if(conflict||chosen.conflict){p.status='待审核';if(p.orderId)ledger.events=ledger.events.filter(e=>e.source!==p.orderId);review(p.id,'同一资金事件性质、身份或状态证据冲突，暂停确认支出');continue;}
   if(p.direction==='in')continue;
   if(p.raw.statementDirection && p.raw.statementDirection!=='支出'){
     p.direction=p.raw.statementDirection==='收入'?'in':'neutral';p.fundsPosted=false;p.status='待审核';
     review(p.id,'微信明细标为收入或中性交易，保留原始方向，不确认支出');continue;
   }
   if(p.raw.reviewClassification&&p.raw.ownership==='未知'){p.status='待识别';if(p.orderId)ledger.events=ledger.events.filter(e=>e.source!==p.orderId);review(p.id,'审核仍无法确认收款对象是否为本人，暂不计支出');continue;}
   if(p.status==='购物订单'){
     if(!p.fundsPosted){ledger.events=ledger.events.filter(e=>e.source!==p.orderId);review(p.id,'付款成功状态缺失或未成功，订单暂不确认支出');}
     continue;
   }
   if(p.shopping||p.status==='待审核'){if(p.status!=='待审核')p.status='购物待关联';review(p.id,'购物或外卖需要可靠订单关联及完成证据');continue;}
   const r=p.raw;
   if(['账户转账','信用卡还款'].includes(r.kind)){
     if(r.ownership==='本人'&&r.recipient&&(r.evidence||r.reviewClassification)){p.status=r.kind+'（不计支出）';}
     else {p.status='待识别';review(p.id,'无法确认是否为本人账户或本人信用卡，不自动计入支出');}
     continue;
   }
   if(['红包','对外转账'].includes(r.kind)){
     if(r.ownership==='本人'){p.status='本人账户转移（不计支出）';continue;}
     if(r.ownership!=='他人'||!r.recipient||!(r.evidence||r.reviewClassification)){p.status='待识别';review(p.id,'无法确认收款对象是否为他人，先待识别');continue;}
     const expected=r.kind==='红包'?'已领取':'已收款';
     if(p.fundsPosted&&r.completionStatus===expected&&r.completedAt&&r.statusEvidence){p.status=expected;event('external:'+p.id,r.completedAt,p.amount,r.category||r.kind,p.id,r.kind+'：'+expected+'，'+r.statusEvidence);}
     else if(r.returnNoted||r.completionStatus==='已退回'){p.status='已退回（未确认支出）';}
     else {p.status='待确认';review(p.id,'缺少可靠的'+expected+'状态、日期或依据，不能推断完成');}
     continue;
   }
   if(['即时消费','缴费'].includes(r.kind)&&(r.evidence||r.reviewClassification)){
     if(p.fundsPosted){p.status=r.kind;event('expense:'+p.id,p.date,p.amount,r.category||r.kind,p.id,'付款成功：'+r.evidence);}
     else{p.status='待确认';review(p.id,'付款状态未成功或缺少可靠成功状态，暂不计支出');}
   }else{p.status='待识别';review(p.id,'无法确定交易性质，不自动计入支出');}
 }
 // 回款独立于原交易保存，按实际成功日期调整；共享关联号已在前一步去重。
 const returned=new Map(),itemReturned=new Map();
 incomingGroups.sort((a,b)=>(a.payment.raw.completedAt||a.payment.date).localeCompare(b.payment.raw.completedAt||b.payment.date));
 for(const {payment:p,conflict}of incomingGroups){
   const r=p.raw,date=r.completedAt||r.date;
   if(conflict||!p.fundsPosted){review(p.id,'退款或退回尚未可靠成功，不冲减支出');continue;}
   ledger.refunds.push({id:p.id,date,amount:p.amount,valid:true,adjustment:0,kind:r.kind,status:'成功'});
   const targets=ledger.payments.filter(q=>q.direction==='out'&&q.raw.paymentRef&&q.raw.paymentRef===r.originalRef);
   if(targets.length!==1||!r.originalRef){review(p.id,'回款未能唯一关联原资金事件，保留流入但不自动冲减');continue;}
   const original=targets[0],used=returned.get(original.id)||0;
   if(date<original.date||used+p.amount>original.rawAmount||original.status==='待审核'){review(p.id,'回款早于原交易、超额或原交易有冲突，暂不冲减');continue;}
   const oid=original.orderId,order=ledger.orders.find(o=>o.id===oid);
   let targetSource=original.id,positive;
   if(order){
     const item=r.targetItemId?order.items.find(i=>i.id===r.targetItemId):order.items.length===1?order.items[0]:null;
     if(!item){review(p.id,'多商品退款需要原商品编号，不能猜测分摊');continue;}
     const itemKey=order.id+'|'+item.id,iu=itemReturned.get(itemKey)||0;
     if(iu+p.amount>item.amount){review(p.id,'该商品累计退款超额，暂不冲减');continue;}
     itemReturned.set(itemKey,iu+p.amount);targetSource=order.id;
     positive=ledger.events.find(e=>e.id==='r:'+order.id+':'+item.id&&e.amount>0);
     order.refund+=p.amount;
     if(!positive){order.remaining=Math.max(0,order.remaining-p.amount);}
   }else positive=ledger.events.find(e=>e.source===targetSource&&e.amount>0);
   returned.set(original.id,used+p.amount);p.originalId=original.id;p.status='回款已关联';
   original.outstandingAmount=original.rawAmount-used-p.amount;
   if(!positive&&!order&&original.outstandingAmount===0)original.status='已全额退回（不计支出）';
   if(positive){
     if(date<positive.date){positive.amount=Math.max(0,positive.amount-p.amount);}
     else{event('return:'+p.id,date,-p.amount,positive.category,targetSource,r.kind+'成功，关联原交易并按成功日期冲减');ledger.refunds[ledger.refunds.length-1].adjustment=p.amount;}
   }
 }
 for(const p of ledger.payments){if(p.direction==='out'&&p.raw.returnNoted&&!returned.has(p.id))review(p.id,'原交易标记退回，但缺少关联退回款流水；不猜测回款金额和日期');}
 for(const o of ledger.orders){o.net=ledger.events.filter(e=>e.source===o.id).reduce((s,e)=>s+e.amount,0);o.confirmed=ledger.events.filter(e=>e.source===o.id&&e.amount>0).reduce((s,e)=>s+e.amount,0);if(o.platform==='美团'||o.platform==='饿了么'||o.raw.orderKind==='外卖')o.status=o.confirmed?'订单已完成':'外卖待完成';}
}
module.exports={resolvePaymentVersions,applyExpenseRules};


};
factories["src/operation-history"]=function(module,load){
'use strict';
const {keyOf}=load("src/import-ledger");
const {createHash}=load("phone-src/hash");
const controls=new Set(['undo','unlink']);
function active(rows){
 const skipped=new Set(), result=[];
 for(const row of [...rows].reverse()){
  if(skipped.has(row.id))continue;
  result.push(row);
  if(controls.has(row.payload.action))skipped.add(row.payload.targetId);
 }
 return result.reverse();
}
// Include related orders, returns and possible duplicate candidates, even across channels.
function context(records,p){
 const keys=new Set([p.entityKey,p.peerKey].filter(Boolean)),refs=new Set(),selected=new Set();
 const tags=v=>[v.paymentRef,v.originalRef,v.orderNo,v.transactionId,v.walletTransactionId].filter(Boolean).map(x=>'ref:'+x)
  .concat(v.merchant?['candidate:'+JSON.stringify([v.date,v.amount,v.merchant])]:[]);
 let changed=true;
 while(changed){changed=false;for(const r of records){
  if(selected.has(r))continue;
  const identifiers=tags(r.value);
  if(keys.has(keyOf(r))||identifiers.some(x=>refs.has(x))){selected.add(r);keys.add(keyOf(r));identifiers.forEach(x=>refs.add(x));changed=true;}
 }}
 const hash=createHash('sha256').update(JSON.stringify([...selected].map(r=>JSON.stringify([r.type,r.value])).sort())).digest('hex');
 return {keys,hash};
}
function conflict(records,rows,row){
 if(!row)return '找不到这项操作。';
 if(row.action==='undo')return '撤销记录永久保留，不能再次撤销。';
 if(!active(rows).includes(row))return '这项操作已撤销或已解除关联。';
 const c=context(records,row.payload);
 if(row.payload.contextHash&&c.hash!==row.payload.contextHash)return '相关原始账单已有新版本或新的关联来源，请重新审核。';
 if(!row.payload.contextHash){
  // Older logs lack a dependency fingerprint: require all original sources to be known.
  const basis=new Set(row.payload.basis);
  if(records.some(r=>c.keys.has(keyOf(r))&&!basis.has(createHash('sha256').update(JSON.stringify([r.type,r.value])).digest('hex'))))return '旧操作缺少完整关联依据，无法安全撤销。';
 }
 if(active(rows).some(x=>x.id>row.id&&x.action!=='undo'&&(c.keys.has(x.payload.entityKey)||c.keys.has(x.payload.peerKey))))return '相关交易后来又被修改，请先处理较新的操作。';
 return '';
}
function control(records,rows,body){
 const row=rows.find(x=>x.id===body.targetId),why=conflict(records,rows,row);
 if(why)throw Error(why);
 if(body.action==='unlink'&&row.action!=='duplicate')throw Error('只能解除人工确认的重复关联');
 if(typeof body.reason!=='string'||body.reason.trim().length<2||body.reason.length>1000)throw Error('请填写至少两个字的原因');
 return {action:body.action,targetId:row.id,entityKey:row.payload.entityKey,peerKey:row.payload.peerKey,contextHash:context(records,row.payload).hash,reason:body.reason.trim()};
}
module.exports={active,context,conflict,control,controls};

};
factories["src/review-engine"]=function(module,load){
'use strict';
const {createHash}=load("phone-src/hash");const {keyOf,makeLedger}=load("src/import-ledger");
const fingerprint=r=>createHash('sha256').update(JSON.stringify([r.type,r.value])).digest('hex');
const kinds=['即时消费','缴费','购物','外卖','红包','对外转账','账户转账','信用卡还款'];
const protectedKind=r=>r.type==='orders'?(r.value.orderKind==='外卖'||['美团','饿了么'].includes(r.value.platform)?'外卖':'购物'):r.value.kind;
function decide(records,body){
 if(!body||typeof body!=='object'||!['classify','duplicate','dispute','evidence','defer'].includes(body.action))throw Error('请选择有效审核操作');
 if(typeof body.entityKey!=='string'||typeof body.reason!=='string'||body.reason.trim().length<2||body.reason.length>1000)throw Error('请选择记录，并填写至少两个字的审核原因');
 const target=records.filter(r=>keyOf(r)===body.entityKey);if(!target.length)throw Error('审核记录已不存在，请刷新');
 const out={action:body.action,entityKey:body.entityKey,reason:body.reason.trim()};let related=[...target];
 if(body.action==='classify'){
  if(target[0].type==='orders')throw Error('订单不能手工改成即时消费；请使用已有完成证据');
  if(!kinds.includes(body.kind)||!['本人','他人','未知'].includes(body.ownership))throw Error('请选择交易性质及对象身份');
  if(typeof body.recipient!=='string'||!body.recipient.trim()||body.recipient.length>150)throw Error('请填写收款对象名称');
  if(body.ownership==='本人'&&!['账户转账','信用卡还款'].includes(body.kind))throw Error('本人收款应选择本人账户划转或信用卡还款，不作为消费');
  if(body.kind==='账户转账'&&body.ownership!=='本人')throw Error('本人账户划转必须确认对象为本人');
  const restricted=target.map(protectedKind).filter(k=>['购物','外卖','红包','对外转账','退款','退回款','信用卡还款','账户转账'].includes(k));
  const shopping=target.some(r=>r.value.orderNo||r.value.platform||/拼多多|抖音|淘宝|京东|美团|饿了么/.test(r.value.merchant));
  if(shopping&&!['购物','外卖'].includes(body.kind))throw Error('已有购物或外卖线索，不能改成即时支出来绕过完成证据');
  if(restricted.some(k=>['退款','退回款'].includes(k)))throw Error('回款不得改为支出，必须保留原回款性质与成功状态');
  if(restricted.some(k=>!['购物','外卖'].includes(k))&&!restricted.includes(body.kind)&&!(body.kind==='账户转账'&&body.ownership==='本人')&&!(restricted.every(k=>k==='账户转账')&&body.kind==='对外转账'&&body.ownership==='他人'))throw Error('不能通过改类别绕过领取、收款或还款规则');
  if(target.some(r=>['待领取','已领取'].includes(r.value.completionStatus))&&!['红包','账户转账'].includes(body.kind))throw Error('已有红包领取线索，不能绕过领取规则');
  if(target.some(r=>['待收款','已收款'].includes(r.value.completionStatus))&&!['对外转账','账户转账'].includes(body.kind))throw Error('已有对方收款线索，不能绕过收款规则');
  if(restricted.includes('外卖')&&body.kind!=='外卖')throw Error('外卖必须保留订单已完成条件');
  if(restricted.includes('购物')&&body.kind!=='购物')throw Error('购物必须保留确认收货条件');
  Object.assign(out,{kind:body.kind,ownership:body.ownership,recipient:body.recipient.trim(),category:typeof body.category==='string'?body.category.trim().slice(0,80):''});
 }
 if(body.action==='dispute'){
  const peer=records.filter(r=>keyOf(r)===body.peerKey);
  if(!peer.length||body.peerKey===body.entityKey||!makeLedger(records).ledger.payments.some(p=>p.sourceIds.includes(body.entityKey)&&p.sourceIds.includes(body.peerKey)))throw Error('只能暂停原始证据已自动关联的两条来源');
  out.peerKey=body.peerKey;related.push(...peer);
 }
 if(body.action==='duplicate'){
  const peer=records.filter(r=>keyOf(r)===body.peerKey);if(!peer.length||body.peerKey===body.entityKey||target[0].type==='orders'||peer[0].type==='orders')throw Error('请选择另一笔支付来源');
  const all=[...target,...peer],a=all[0].value;
  if(!a.paymentRef||all.some(r=>!r.value.evidence||r.value.paymentRef!==a.paymentRef||r.value.amount!==a.amount||r.value.date!==a.date||r.value.account!==a.account))throw Error('证据不足：必须有原始来源中的同一资金关联号、依据、账户、金额及日期；不能仅凭金额合并');
  Object.assign(out,{peerKey:body.peerKey,paymentRef:a.paymentRef});related=all;
 }
 if(body.action==='evidence'){
  const evidence=records.find(r=>fingerprint(r)===body.evidenceId);if(!evidence)throw Error('请选择已导入的原始证据，不能手工填写完成状态');
  const a=target[0].value,b=evidence.value;
  if(evidence.type==='orders'){
   if(target[0].type!=='orders'||keyOf(evidence)!==body.entityKey||target.some(r=>r.value.amount!==b.amount||r.value.date!==b.date||r.value.paymentRef!==b.paymentRef))throw Error('订单证据必须对应同一平台、订单、商品、金额和付款信息');
   const expected=protectedKind(evidence)==='外卖'?'订单已完成':'已确认收货';
   if(b.status!==expected||!b.receiptDate||!b.evidence)throw Error('所选订单没有可靠的'+expected+'证据');
  }else{
   if(target[0].type==='orders'||a.amount!==b.amount||a.account!==b.account||a.date!==b.date||!(keyOf(evidence)===body.entityKey||(a.paymentRef&&a.paymentRef===b.paymentRef)))throw Error('状态证据与原资金事件不一致');
   if(!b.statusEvidence||!b.completedAt||!(['已领取','已收款'].includes(b.completionStatus)||b.returnStatus==='成功'))throw Error('证据必须包含已领取、已收款或回款成功的状态、日期及依据');
   if(a.kind&&a.kind!=='待识别'&&b.kind!==a.kind)throw Error('证据交易性质不一致');
  }
  out.evidenceId=body.evidenceId;related.push(evidence);
 }
 out.basis=[...new Set(related.map(fingerprint))].sort();return out;
}
function reviewedLedger(records,decisions=[]){
 const effective=structuredClone(records),warnings=[];
 for(const item of load("src/operation-history").active(decisions).filter(x=>!["undo","unlink"].includes(x.payload?.action))){const d=item.payload||item;try{
   const current=records.filter(r=>keyOf(r)===d.entityKey||d.peerKey&&keyOf(r)===d.peerKey);const basis=new Set(d.basis||[]);
   if(current.some(r=>!basis.has(fingerprint(r)))||!current.length)throw Error('原始来源已更新，请重新审核');
   const checked=decide(records,d);
   if(d.action==='classify')for(const r of effective.filter(r=>keyOf(r)===d.entityKey)){Object.assign(r.value,{kind:checked.kind,ownership:checked.ownership,recipient:checked.recipient,reviewClassification:true});if(checked.category)r.value.category=checked.category;}
   if(d.action==='dispute')for(const r of effective.filter(r=>[d.entityKey,d.peerKey].includes(keyOf(r))))r.value.reviewLinkDisputed=true;
   if(d.action==='duplicate')for(const r of effective.filter(r=>[d.entityKey,d.peerKey].includes(keyOf(r))))r.value.reviewDuplicateApproved=d.paymentRef;
   if(d.action==='evidence'){
    const proof=records.find(r=>fingerprint(r)===d.evidenceId);
    for(const r of effective.filter(r=>keyOf(r)===d.entityKey))for(const k of (proof.type==='orders'?['status','receiptDate','evidence']:['completionStatus','completedAt','statusEvidence','returnStatus','paymentStatus'])){if(proof.value[k]!==undefined)r.value[k]=proof.value[k];}
   }
  }catch(e){warnings.push({id:d.entityKey,reason:'审核决定暂不生效：'+e.message});}}
 const state=makeLedger(effective);state.ledger.review.push(...warnings);return {...state,effectiveRecords:effective};
}
function queue(records,decisions,sources=[]){
 const state=reviewedLedger(records,decisions),groups=new Map();for(const r of records){const k=keyOf(r);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 const entities=[];
 for(const [key,rows]of groups){const first=rows[0],v=first.value,order=first.type==='orders'?state.ledger.orders.find(o=>o.id===JSON.stringify([v.platform,v.orderNo])):null;
  const payment=state.ledger.payments.find(p=>p.sourceIds.includes(key));
  const relatedId=order?.id||payment?.id||key;
  const reasons=state.ledger.review.filter(r=>r.id===relatedId||r.id===key||r.id.includes(key)).map(r=>r.reason);
  const pending=order?order.remaining>0:payment&&['待识别','待确认','待审核','购物待关联','回款待确认'].includes(payment.status);
  if(pending&&!reasons.length)reasons.push(order?'尚无可靠的订单完成证据':'尚无可靠成功状态');
  entities.push({key,type:first.type,title:order?`${v.platform} ${v.orderNo} / ${v.itemId}`:v.merchant,amount:v.amount,date:v.date,status:payment?.status||order?.status||'待识别',reasons,pending:!!pending||reasons.length>0,channel:payment?.channels||first.type,account:v.account||'',recipient:payment?.recipient||v.recipient||'',ownership:payment?.ownership||v.ownership||'未知',kind:payment?.nature||protectedKind(first)||'待识别',order:order||state.ledger.orders.find(o=>o.id===payment?.orderId)||null,
   relatedOrders:state.input.orders.filter(o=>state.input.links.some(l=>l.paymentId===key&&l.orderId===o.id)||first.type==='orders'&&o.id===JSON.stringify([v.platform,v.orderNo])),
   originals:rows.map(r=>({fingerprint:fingerprint(r),type:r.type,line:r.line,value:r.value,sources:sources.filter(s=>s.fingerprint===fingerprint(r))})),history:decisions.filter(d=>(d.payload||d).entityKey===key)});
 }
 return {entities,items:entities.filter(e=>e.pending),ledger:state.ledger};
}
module.exports={fingerprint,decide,reviewedLedger,queue,kinds};

};
factories["src/scan-format"]=function(module,load){
'use strict';
// These are fingerprints of the shipped generic-header fixtures, not filename hints.
const fixtures={
 '47bb6780c1d32612a1993d561303b63b0651bc0334a112ad1be7d20d392b3c5b':'wechat',
 'a85d4aadc188a9d63bb978eb0e231c3ded002c41646b93cd87ce67e4bee5e57c':'bank',
 'bc68dd0c28d8f1bf2db5bc8b439948d96e1d546f7d56d31523346db1d5ad8ef2':'alipay',
 '2410eacfb30d7ebca4c8a76c61fb069edce23abb94aa8c603e9a584b4dd10b85':'wechat',
 '30673e63af8537b7e594fcf81ffef1bab87b51a831b53324396b3f1e5f512830':'wechat'
};
const csv=load("public/csv");
function identify(text,hash){
 const {headers:h,rows}=csv.parseCSV(text),types=new Set();
 for(const [key,type] of [['交易单号','wechat'],['交易号','alipay'],['银行流水号','bank']]){
  const signature={wechat:['交易时间','交易对方','付款账户'],alipay:['交易日期','商户名称','账户'],bank:['交易日期','支出金额','资金账户']}[type];
  if(h.includes(key)&&signature.every(n=>h.includes(n)))types.add(type);
 }
 if(csv.schema('orders').filter(x=>x[2]).every(([k])=>csv.autoMap('orders',h)[k]))types.add('orders');
 if(fixtures[hash])types.add(fixtures[hash]);
 if(h.includes('账单来源'))for(const row of rows){
  const label=row[h.indexOf('账单来源')].trim(),t=new Map([['微信','wechat'],['支付宝','alipay'],['银行卡','bank'],['平台订单','orders']]).get(label);
  if(!t)throw Error('账单来源列含空白或不支持的来源');types.add(t);
 }
 if(types.size!==1)throw Error('不能唯一确定来源；通用表头请提供明确的“账单来源”列。');
 const [type]=types,map=csv.autoMap(type,h);
 for(const [key,label,,aliases] of csv.schema(type))if([label,...aliases].filter(n=>h.includes(n)).length>1)throw Error('字段含义重复：'+label);
 return {type,mapping:map};
}
module.exports={identify};

};
factories["public/csv"]=function(module,load){
(function () {
'use strict';
const fields={
 payments:[['transactionId','流水号',true,['交易单号','交易号','银行流水号']],['date','付款日期',true,['交易时间','交易日期']],['amount','付款金额',true,['金额','支出金额']],['merchant','商户',true,['交易对方','商户名称']],['account','资金账户',true,['付款账户','账户']],['kind','消费类型',false,['交易类型']],['category','类别',false,[]],['paymentRef','资金关联号',false,['支付关联号']],['platform','购物平台',false,['平台']],['orderNo','订单号',false,[]],['evidence','依据',false,['识别依据']],['virtual','虚拟标记',true,[]]],
 orders:[['orderNo','订单号',true,[]],['platform','购物平台',true,['平台']],['itemId','商品编号',true,['明细号']],['name','商品名称',true,[]],['amount','商品实付金额',true,['实付金额']],['date','付款日期',true,[]],['paymentRef','资金关联号',false,['支付关联号']],['status','收货状态',true,['订单状态']],['receiptDate','确认收货日期',false,[]],['evidence','依据',true,['状态依据']],['category','类别',false,[]],['virtual','虚拟标记',true,[]]]
};
const extraPaymentFields=[['recipient','收款对象',false,[]],['ownership','收款对象身份',false,[]],['paymentStatus','付款状态',false,[]],['completionStatus','对方状态',false,[]],['completedAt','状态成功日期',false,[]],['statusEvidence','状态依据',false,[]],['originalRef','原资金关联号',false,[]],['targetItemId','原商品编号',false,[]],['returnStatus','回款状态',false,[]]];
fields.payments.push(...extraPaymentFields,['walletChannel','原支付渠道',false,[]],['walletTransactionId','渠道流水号',false,[]]);
fields.orders.push(['orderKind','订单性质',false,[]]);
function schema(type){if(!['wechat','alipay','bank','orders'].includes(type))throw Error('请选择有效的账单来源');return fields[type==='orders'?'orders':'payments'];}
function parseCSV(text){
 if(typeof text!=='string'||text.length>1000000)throw Error('CSV 文件过大，最多 1 MB 文本');
 text=text.replace(/^\uFEFF/,'');if(text.includes('\uFFFD'))throw Error('文件编码不正确，请另存为 UTF-8 CSV');
 const rows=[],lineNumbers=[];let row=[],cell='',quoted=false,closed=false,line=1,rowStart=1;
 const endCell=()=>{row.push(cell);cell='';closed=false;};
 const endRow=()=>{endCell();if(row.some(x=>x.trim())){rows.push(row);lineNumbers.push(rowStart);}row=[];};
 for(let i=0;i<text.length;i++){
   const c=text[i];
   if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else {quoted=false;closed=true;}}else {cell+=c;if(c==='\n'||(c==='\r'&&text[i+1]!=='\n'))line++;}continue;}
   if(c==='"'){if(cell||closed)throw Error('CSV 引号位置错误');quoted=true;}
   else if(c===',')endCell();
   else if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;endRow();line++;rowStart=line;}
   else {if(closed)throw Error('CSV 结束引号后只能接逗号或换行');cell+=c;}
 }
 if(quoted)throw Error('CSV 有未闭合的引号');if(cell||row.length||closed)endRow();
 if(rows.length<2)throw Error('CSV 至少需要表头和一行虚拟数据');
 const headers=rows.shift().map(h=>h.trim());lineNumbers.shift();
 if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw Error('CSV 表头不能为空或重复');
 if(headers.length>40||rows.length>2000)throw Error('每个文件最多 40 列、2000 行');
 rows.forEach((r,i)=>{if(r.length!==headers.length)throw Error(`第 ${lineNumbers[i]} 行列数不一致：应有 ${headers.length} 列，实际 ${r.length} 列`);});
 return {headers,rows,lineNumbers};
}
function autoMap(type,headers){const map={};for(const [key,label,,aliases]of schema(type)){map[key]=[label,...aliases].find(s=>headers.includes(s))||'';}return map;}
function date(value){const d=new Date(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw Error('日期须为有效 YYYY-MM-DD，例如 2026-11-01');return value;}
function amount(value){if(!/^\d{1,9}(\.\d{1,2})?$/.test(value))throw Error('金额须为正数，最多两位小数，不带货币符号');const [a,b='']=value.split('.');const n=Number(a)*100+Number(b.padEnd(2,'0'));if(n<=0)throw Error('金额必须大于零');return n;}
function normalize(text,type,mapping){
 const parsed=parseCSV(text),spec=schema(type),errors=[],records=[];
 if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw Error('缺少字段映射');
 const used=[];for(const [key,label,required]of spec){const h=mapping[key];if(required&&!h)throw Error(`请映射必填字段：${label}`);if(h&&!parsed.headers.includes(h))throw Error(`字段不存在：${label}`);if(h)used.push(h);}
 if(new Set(used).size!==used.length)throw Error('同一 CSV 列不能映射到多个字段');
 parsed.rows.forEach((cells,i)=>{try{
   const r={};for(const [key,label,required]of spec){r[key]=mapping[key]?cells[parsed.headers.indexOf(mapping[key])].trim():'';if(required&&!r[key])throw Error(`${label}不能为空`);}
   if(r.virtual!=='是')throw Error('只接受虚拟标记为“是”的测试账单');
   r.date=date(r.date);r.amount=amount(r.amount);
   if(type==='orders'){
     if(!['拼多多','抖音','淘宝','京东','美团','饿了么'].includes(r.platform))throw Error('不支持的购物或外卖平台');
     if(r.orderKind&&!['网购','外卖'].includes(r.orderKind))throw Error('订单性质只能为网购或外卖');
     const food=r.orderKind==='外卖'||['美团','饿了么'].includes(r.platform);
     if(!['待确认','待收货','已发货','已签收','已确认收货','制作中','配送中','订单已完成'].includes(r.status))throw Error('未知订单状态，请检查字段映射');
     if((food&&r.status==='已确认收货')||(!food&&r.status==='订单已完成'))throw Error('外卖必须使用“订单已完成”，网购必须使用“已确认收货”');
     if(['已确认收货','订单已完成'].includes(r.status)){r.receiptDate=date(r.receiptDate);if(r.receiptDate<r.date)throw Error('确认完成日期不能早于付款日期');}
     else if(r.receiptDate)throw Error('仅已确认收货或订单已完成可以填写确认日期');
     if(!r.orderKind)delete r.orderKind;
   }else{
     if(r.walletChannel||r.walletTransactionId){
       if(type!=='bank'||(r.walletChannel&&!['微信','支付宝'].includes(r.walletChannel)))throw Error('原支付渠道只适用于银行账单，可填写微信或支付宝');
     }else{delete r.walletChannel;delete r.walletTransactionId;}
     if(r.platform&&!['拼多多','抖音','淘宝','京东','美团','饿了么'].includes(r.platform))throw Error('购物平台名称不支持');
     if((r.orderNo&&!r.platform)||(!r.orderNo&&r.platform))throw Error('购物平台与订单号必须同时填写');
     if(r.kind&&!['即时消费','缴费','购物','外卖','红包','对外转账','待识别','账户转账','信用卡还款','退款','退回款'].includes(r.kind))throw Error('不支持的交易性质；本阶段不含借款管理');
     if(r.kind==='即时消费'&&!r.evidence)throw Error('即时消费需要明确识别依据，否则请选择待识别');
     if(r.ownership&&!['本人','他人','未知'].includes(r.ownership))throw Error('收款对象身份只能为本人、他人或未知');
     if(r.paymentStatus&&!['成功','处理中','失败'].includes(r.paymentStatus))throw Error('付款状态只能为成功、处理中或失败');
     if(r.completionStatus&&!['待领取','已领取','待收款','已收款','已退回','未知'].includes(r.completionStatus))throw Error('对方状态不支持');
     if(r.returnStatus&&!['成功','申请中','失败'].includes(r.returnStatus))throw Error('回款状态不支持');
     if(r.completedAt){r.completedAt=date(r.completedAt);if(r.completedAt<r.date)throw Error('状态成功日期不能早于交易日期');}
     for(const [key]of extraPaymentFields)if(!r[key])delete r[key];
     if(extraPaymentFields.some(([key])=>mapping[key]))r.ruleVersion=3;
   }
   r.category=r.category||(/地铁|公交/.test(r.merchant||'')?'交通':/面馆|餐厅|饭店/.test(r.merchant||'')?'餐饮':type==='orders'?'购物':'未分类');
   records.push({type,line:parsed.lineNumbers[i],value:r});
 }catch(e){errors.push({line:parsed.lineNumbers[i],message:e.message});}});
 return {...parsed,records,errors};
}
const api={schema,parseCSV,autoMap,normalize};if(typeof module!=='undefined')module.exports=api;else globalThis.MyMoneyCSV=api;
})();

};
factories["public/ledger"]=function(module,load){
(function () {
function unique(rows,key) {
  const seen=new Map(), result=[], conflicts=[];
  for(const row of rows){const id=key(row); if(seen.has(id)){if(JSON.stringify(seen.get(id))!==JSON.stringify(row)) conflicts.push(id); continue;}seen.set(id,row);result.push(row);}
  return {rows:result,conflicts};
}
function buildLedger(input){
  const review=[], addReview=(id,reason)=>review.push({id,reason});
  const p=unique(input.payments||[],x=>x.id), o=unique(input.orders||[],x=>x.id);
  const rr=unique(input.receipts||[],x=>x.id), rf=unique(input.refunds||[],x=>x.id);
  const blocked=new Set(p.conflicts);
  p.conflicts.forEach(id=>addReview(id,'相同流水号内容冲突，暂不统计'));
  const invalidOrders=new Set(o.conflicts);
  o.conflicts.forEach(id=>addReview(id,'相同订单号内容冲突，暂不确认消费'));
  rr.conflicts.forEach(id=>addReview(id,'收货证据内容冲突'));
  rf.conflicts.forEach(id=>addReview(id,'退款证据内容冲突'));
  const groups=new Map();
  for(const payment of p.rows){const key=payment.economicId||payment.id; if(!groups.has(key))groups.set(key,[]);groups.get(key).push(payment);}
  const events=[], payments=[], orders=[], refunds=[];
  const push=(id,date,amount,category,source,reason)=>events.push({id,date,amount,category,source,reason});
  for(const [id,rows] of groups){
    const first=rows[0], links=(input.links||[]).filter(l=>rows.some(p=>p.id===l.paymentId));
    const reliable=links.filter(l=>l.reliable&&l.evidence), ids=[...new Set(reliable.map(l=>l.orderId))];
    const conflict=rows.some(x=>blocked.has(x.id)||x.amount!==first.amount||x.date!==first.date);
    let status='待识别';
    if(conflict){status='待审核';addReview(id,'同一资金事件的金额、日期或原始内容冲突');}
    else if(ids.length===1 && o.rows.some(o=>o.id===ids[0]) && !invalidOrders.has(ids[0])) status='购物订单';
    else if(ids.length || links.length){status='待审核';addReview(id,'订单关联证据不完整或存在多个候选');}
    else if(rows.some(x=>x.kind==='transfer'||x.kind==='repayment')) status=first.kind==='repayment'?'信用卡还款':'账户转账';
    else if(first.kind==='instant' && first.evidence){status='即时消费';push('p:'+id,first.date,first.amount,first.category||'其他',id,first.evidence);}
    else addReview(id,'无法确定即时消费或电商购物；等待可靠订单或人工审核');
    payments.push({...first,id,sourceIds:rows.map(x=>x.id),channels:[...new Set(rows.map(x=>x.channel))].join(' / '),status,orderId:ids.length===1?ids[0]:null,amount:conflict?0:first.amount,rawAmount:first.amount});
  }
  for(const order of o.rows){
    let confirmed=0,remaining=0,totalRefund=0;
    if(invalidOrders.has(order.id)){orders.push({...order,confirmed:0,remaining:order.paid,refund:0,net:0,status:'待审核'});continue;}
    for(const item of order.items){
      const receipts=rr.rows.filter(r=>r.orderId===order.id&&r.itemId===item.id&&!rr.conflicts.includes(r.id)&&r.status==='已确认收货'&&r.reliable&&r.evidence&&/^\d{4}-\d{2}-\d{2}$/.test(r.date||''));
      const receipt=receipts.sort((a,b)=>a.date.localeCompare(b.date))[0];
      let before=0,after=0;
      for(const r of rf.rows.filter(r=>r.orderId===order.id&&r.itemId===item.id)){
        let adjustment=0,valid=r.status==='成功'&&!rf.conflicts.includes(r.id)&&r.evidence&&/^\d{4}-\d{2}-\d{2}$/.test(r.date||'')&&Number.isSafeInteger(r.amount)&&r.amount>0;
        if(valid && before+after+r.amount>item.amount){valid=false;addReview(r.id,'累计退款超过商品实付金额');}
        if(valid){totalRefund+=r.amount;if(receipt && r.date>=receipt.date){after+=r.amount;adjustment=r.amount;push('f:'+r.id,r.date,-r.amount,order.category,order.id,'退款成功，按成功日期冲减');}else before+=r.amount;}
        else if(r.status==='成功')addReview(r.id,'退款缺少可靠证据、日期或金额异常');
        refunds.push({...r,valid,adjustment});
      }
      if(receipt){const amount=item.amount-before;confirmed+=amount;push('r:'+order.id+':'+item.id,receipt.date,amount,order.category,order.id,receipt.evidence);}else remaining+=Math.max(0,item.amount-before);
    }
    const net=events.filter(e=>e.source===order.id).reduce((s,e)=>s+e.amount,0);
    orders.push({...order,confirmed,remaining,refund:totalRefund,net,status:remaining===0?(confirmed?'已确认 / 已结清':'收货前全额退款'):(confirmed?'部分确认收货':'待确认收货')});
  }
  return {payments,orders,refunds,events,review};
}
function summarize(ledger,month){
  const events=ledger.events.filter(x=>x.date.startsWith(month)), payments=ledger.payments.filter(x=>x.date.startsWith(month));
  const outflow=payments.filter(p=>p.direction!=='in'&&p.fundsPosted!==false).reduce((s,p)=>s+p.amount,0), refund=ledger.refunds.filter(r=>r.valid&&r.date.startsWith(month)).reduce((s,r)=>s+r.amount,0);
  const confirmed=events.filter(x=>x.amount>0).reduce((s,x)=>s+x.amount,0),adjustment=events.filter(x=>x.amount<0).reduce((s,x)=>s-x.amount,0);
  const categories={}; for(const e of events)categories[e.category]=(categories[e.category]||0)+e.amount;
  return {outflow,refund,netOutflow:outflow-refund,confirmed,adjustment,netConsumption:confirmed-adjustment,totalExpense:confirmed-adjustment,pending:ledger.orders.reduce((s,o)=>s+o.remaining,0),unknown:ledger.payments.filter(p=>p.status==='待识别').reduce((s,p)=>s+p.amount,0),categories};
}
const api={buildLedger,summarize}; if(typeof module!=='undefined')module.exports=api;else globalThis.MyMoneyLedger=api;
})();

};
factories["phone-src/hash"]=function(module,load){
'use strict';
// Synchronous SHA-256 adapter for the shared review fingerprint API.
// Encryption and password derivation exclusively use Web Crypto.
function sha256(text){
 const input=new TextEncoder().encode(text),length=Math.ceil((input.length+9)/64)*64;
 const padded=new Uint8Array(length),view=new DataView(padded.buffer);
 padded.set(input);padded[input.length]=128;view.setBigUint64(length-8,BigInt(input.length)*8n);
 const state=Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
 const rotate=(x,n)=>(x>>>n)|(x<<(32-n));
 const words=new Uint32Array(64);
 for(let offset=0;offset<length;offset+=64){
  for(let i=0;i<16;i++)words[i]=view.getUint32(offset+4*i);
  for(let i=16;i<64;i++){
   const x=words[i-15],y=words[i-2];
   words[i]=words[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+words[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10));
  }
  let [a,b,c,d,e,f,g,h]=state;
  for(let i=0;i<64;i++){
   const t=h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+words[i];
   const u=(rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c));
   [a,b,c,d,e,f,g,h]=[(t+u)>>>0,a,b,c,(d+t)>>>0,e,f,g];
  }
  [a,b,c,d,e,f,g,h].forEach((v,i)=>state[i]+=v);
 }
 return Array.from(state,v=>v.toString(16).padStart(8,'0')).join('');
}
const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
module.exports={sha256,createHash:()=>({update:value=>({digest:()=>sha256(value)})})};

};
function load(id){if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](m,load);}return cache[id].exports;}return {zip:load('src/wechat-zip'),personal:load('src/wechat-personal'),core:load('src/event-book'),identify:load('src/scan-format').identify,sha256:load('phone-src/hash').sha256};})();
