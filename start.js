'use strict';
(async()=>{
 const status=document.getElementById('offline');
 const controlled=()=>navigator.serviceWorker?.controller?.scriptURL===new URL('sw.js',location.href).href;
 function show(){if(status)status.textContent=controlled()?'离线界面已就绪 · 账本只保存在此设备':'离线界面尚未就绪，请保持连接直到准备完成。';}
 show();
 try{
  navigator.serviceWorker.addEventListener('controllerchange',show);
  const registration=await navigator.serviceWorker.register('sw.js',{scope:'./',updateViaCache:'none'});
  function updateStatus(){
    if(registration.waiting && status) status.textContent="新版程序已准备好。请完成当前操作，关闭所有 MyMoney 窗口后重新打开。";
  }
  registration.addEventListener("updatefound",()=>registration.installing?.addEventListener("statechange",updateStatus));
  await navigator.serviceWorker.ready;show();updateStatus();
 }catch{show();}
})();

