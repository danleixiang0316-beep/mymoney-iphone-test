'use strict';
const $=id=>document.getElementById(id), money=n=>'¥ '+(n/100).toFixed(2);
const now=new Date();$('month').value=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
let importToken,restoreToken,exportRevision,objectUrl,sequence=0;
async function refresh(){
 const a=await Phone.read(),b=PhoneRules.core.replay(a.events),q=PhoneRules.core.queue(b),m=$('month').value;
 $('total').textContent=money(PhoneRules.core.summarize(q.ledger,m).totalExpense);
 $('counts').textContent='待审核 '+q.items.length+' 笔 · 已保存 '+b.batches.length+' 个批次';
 $('rows').textContent=[...q.ledger.events.filter(e=>e.date.startsWith(m)).map(e=>e.date+' '+e.category+' 确认 '+money(e.amount)),
 ...q.ledger.payments.filter(p=>p.date.startsWith(m)).map(p=>p.date+' '+p.merchant+' '+p.account+' '+p.status+' '+money(p.amount))].join('\n')||'本月没有记录。';
 const last=await Phone.meta('backupTime');
 $('last').textContent=last?'最近确认另存：'+new Date(last.time).toLocaleString()+(last.revision!==a.revision?'。账本有变化，请再备份。':'。'):'尚未确认保存过设备外备份。';
 $('safety').hidden=!(await Phone.meta('safety'));
}
function action(id,fn){$(id).onclick=async()=>{const button=$(id);button.disabled=true;try{await fn();}catch(e){$('msg').textContent=e.message;}finally{button.disabled=false;}};}
$('files').onchange=async()=>{
 const own=++sequence;importToken=null;$('save').hidden=true;$('preview').textContent='正在生成预览…';
 try{const p=await Phone.filesPreview([...$('files').files]);if(own!==sequence)return;
 importToken=p.token;$('save').hidden=!p.token;
 $('preview').textContent=[...p.outcomes.map(f=>f.name+' · '+(f.ok?'可导入':'跳过：'+f.error)),
 '新增 '+p.added+' 条，更新版本 '+p.updates+' 条，重复 '+p.duplicates+' 条，导入后全账本待审核 '+p.pending+' 笔。',
 ...p.months.map(x=>x.month+' 资金流出 '+money(x.before.outflow)+' → '+money(x.after.outflow)+'；确认支出 '+money(x.before.totalExpense)+' → '+money(x.after.totalExpense))].join('\n');
 }catch(e){$('preview').textContent=e.message;}
};
action('save',async()=>{await Phone.commit('import',importToken,true);$('save').hidden=true;$('files').value='';$('preview').textContent='已保存到本机。';await refresh();});
$('month').onchange=()=>refresh().catch(e=>$('msg').textContent=e.message);
function link(blob,name){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);$('download').href=objectUrl;$('download').download=name+'.mymoney';$('download').hidden=false;}
action('export',async()=>{const r=await Phone.backup($('password').value);link(r.file,'MyMoney-本机-'+Date.now());exportRevision=r.revision;$('saved').hidden=false;$('password').value='';$('msg').textContent='请点“保存备份文件”，保存后再确认。';});
action('saved',async()=>{await Phone.noteBackup(exportRevision);$('saved').hidden=true;await refresh();});
let restoreSelection=0;
function resetRestore(){restoreSelection++;restoreToken=null;$('restore').hidden=true;$('restoreInfo').textContent='';}
$('password').oninput=resetRestore;$('restoreFile').onchange=resetRestore;
action('validate',async()=>{resetRestore();const version=restoreSelection;const file=$('restoreFile').files[0];if(!file)throw Error('请先选择备份文件');const r=await Phone.restorePreview(file,$('password').value);if(version!==restoreSelection)return;restoreToken=r.token;$('restoreInfo').textContent='校验通过：'+r.records+' 条记录，'+r.batches+' 个批次，'+r.decisions+' 项审核或撤销。确认将替换当前记录、原文件及全部历史。恢复前副本使用本次输入的口令。';$('restore').hidden=false;});
action('restore',async()=>{await Phone.commit('restore',restoreToken,true);resetRestore();$('password').value='';$('msg').textContent='已完成恢复。';await refresh();});
action('safety',async()=>{link(await Phone.meta('safety'),'MyMoney-恢复前');$('saved').hidden=true;$('download').click();});
refresh().catch(e=>$('msg').textContent='无法读取本机账本：'+e.message);
