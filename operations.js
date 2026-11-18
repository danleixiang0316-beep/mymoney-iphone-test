'use strict';
const el=id=>document.getElementById(id), names={classify:'修改类别和收款对象',dispute:'暂停自动关联',duplicate:'关联重复交易',defer:'暂时保留待审核',evidence:'确认原始证据',undo:'撤销修改',unlink:'解除重复关联'};
const money=n=>'¥'+(n/100).toFixed(2);
function describe(scope){
 if(!scope)return '无法可靠还原';
 const keys=scope.effectiveRecords.map(r=>JSON.stringify([r.type,r.value.transactionId]));
 const payments=scope.ledger.payments.filter(p=>p.sourceIds.some(id=>keys.includes(id)));
 return [...scope.effectiveRecords.map(({value:v})=>[v.transactionId||v.orderNo,v.date,money(v.amount),v.kind||v.orderKind,v.category,v.recipient,v.ownership,v.status,v.completionStatus,v.returnStatus,v.receiptDate||v.completedAt].filter(Boolean).join(' · ')),
 ...payments.map(p=>[p.status,'对应 '+p.sourceIds.length+' 条来源',p.orderId?'关联订单：'+p.orderId:''].filter(Boolean).join(' · '))].join('\n');
}
async function api(url,body){return Phone.api(url,body);}
let selected,token;
function item(parent,tag,text){const e=document.createElement(tag);e.textContent=text;parent.append(e);return e;}
async function load(){const rows=await api('/api/operations');el('list').replaceChildren();for(const r of rows){
 const a=item(el('list'),'article','');item(a,'h2','#'+r.id+' '+names[r.action]+(r.targetId?'（对应 #'+r.targetId+'）':''));
 item(a,'p',new Date(r.time).toLocaleString('zh-CN')+' · 原因：'+r.reason);
 const d=item(a,'details','');item(d,'summary','查看修改前后');item(d,'pre',r.historicalReliable===false?'当时审核金额无法可靠还原，原始决定与凭证仍保留。':'修改前：\n'+describe(r.before)+'\n修改后：\n'+describe(r.after));
 if(r.currentAfter){
  const totals=scope=>{const result={};for(const e of scope?.ledger?.events||[]){const month=e.date.slice(0,7);result[month]=(result[month]||0)+e.amount;}return result;};
  const past=totals(r.after),now=totals(r.currentAfter),pastBefore=totals(r.before),nowBefore=totals(r.currentBefore),months=[...new Set([...Object.keys(past),...Object.keys(now),...Object.keys(pastBefore),...Object.keys(nowBefore)])].sort();
  item(d,'h3','当时审核所见金额');
  item(d,'pre',r.historicalReliable?months.map(m=>m+' 操作前 '+money(pastBefore[m]||0)+'；操作后 '+money(past[m]||0)).join('\n')||'无确认支出':'无法可靠还原');
  item(d,'h3','当前规则重算金额');item(d,'p','使用这项操作当时已有的凭证重算；后续新增交易请查看首页。');item(d,'pre',months.map(m=>m+' 操作前 '+money(nowBefore[m]||0)+'；操作后 '+money(now[m]||0)).join('\n')||'无确认支出');
  item(d,'h3','两者差异及原因');
  item(d,'pre',r.historicalReliable?months.map(m=>m+' 差额 '+money((now[m]||0)-(past[m]||0))).join('\n'):'历史金额无法可靠还原，无法计算差额');
  for(const change of r.historicalReliable?(r.differences||[]):[]){
   const e=change.before||change.after;
   item(d,'p',e.date+' · '+change.id+' · '+money(change.before?.amount||0)+' → '+money(change.after?.amount||0)+'。'+change.reason);
   for(const source of change.sources)item(d,'p','原文件 '+source.filename+'，第 '+source.line+' 行；批次 '+source.batchId);
  }
  if(r.applicability)item(d,'p',r.applicability);
 }
 if(r.blocked)item(a,'p',r.blocked);else for(const action of r.action==='duplicate'?['undo','unlink']:['undo']){
 const name=action==='undo'?'撤销':'解除关联';item(a,'button',name).onclick=()=>{selected={action,targetId:r.id};token=null;el('title').textContent=name+'第 '+r.id+' 项操作';el('reason').value='';el('result').textContent='';el('confirm').hidden=true;el('confirm').textContent='确认'+name;el('dialog').showModal();};}
 }el('msg').textContent=rows.length?'共 '+rows.length+' 项操作，最新的在前。':'暂无人工修改或撤销记录。';}
el('reason').oninput=()=>{token=null;el('confirm').hidden=true;el('result').textContent='';};
el('preview').onclick=async()=>{try{const reason=el('reason').value,choice=selected;const p=await api('/api/reviews/preview',{...choice,reason});if(choice!==selected||reason!==el('reason').value)return;token=p.token;el('result').textContent='现在：\n'+describe(p.before)+'\n确认后：\n'+describe(p.after)+'\n'+p.changes.map(x=>x.month+' 总支出：'+money(x.before)+' → '+money(x.after)).join('\n');el('confirm').hidden=false;}catch(e){el('result').textContent=e.message;}};
el('confirm').onclick=async()=>{if(!token)return;const t=token;token=null;el('confirm').hidden=true;try{await api('/api/reviews/commit',{token:t,confirmed:true});el('dialog').close();await load();}catch(e){el('result').textContent=e.message;}};
el('cancel').onclick=()=>el('dialog').close();load().catch(e=>el('msg').textContent=e.message);
