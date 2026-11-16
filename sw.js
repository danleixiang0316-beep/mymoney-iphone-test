'use strict';
const digests = {"app.webmanifest":"fea815cb5c9cf71e796ce82fcb39a42a2fc04e69ad64916dbecca08aecd3351f","home.css":"1dab22d051ce6fb184744f8d8d2f8bb707346eb74c5a931d86dc2c6d042a17f1","home.js":"b5d4938c899cc7fdc7e7e93a750766230681aa476e990a259ee0454d7828dfdf","icon-180.png":"0506fb487f056b02611a90391353fd5a5ac26bb0edf3e4f8c66b02656527e156","icon-192.png":"5cd91df8f2082224ab2b534232283eb69b505b308b148dc72b309ff238cce683","icon-512.png":"7bdb83d8bee5541de07ac111f1eb54f537aa89c48820145d463008f1e5589e7c","import.css":"91a3e857ccacecd836857df8ef9ad9c16f41761e7dac92d6c4c4c71ed8d491cf","index.html":"46557da8b4cf50efb882f268867e20355677c99355c39c6e1fd4df73916289b9","mobile.css":"1528cddb3e3098c638a6eed530ef919aa50b5d70b44f2b0cf93ca82cdf9b92f4","operations.html":"6f06aad64c654cb402a3ac5ca2b0f7ddc222182c0aa37605629577087fe53cb5","operations.js":"e0dfcca9390995e0d6ab1abc2a0eeb3d86d47c776ee0693be9aa7d8341c34f9e","review.html":"758a5b167bd4b5ab507b36f92a5ac7aedf57b968d9d208a7656ec274e13e15d5","review.js":"45d7ed59f13a6be7382aa68172025171b87a754e1d0f9d6dd1d35d98de33db5f","rules.js":"ea78813f69d8e2ad17bf2b290f8d6d35dd55c139be9cfee2648976f471a84119","start.js":"fad3cba33900cce605cdc1d79b94de05e0cc490b974039a70aed9a38aa2404fc","store.js":"87183b92a6ba0a8ea4f42ba8077b4fac1ca8598e6ef56c761f70876459096c2f","style.css":"1db4e880f10865039c2e229d410487b64d1446497603422937f50f0d25d6806e"};
const prefix = 'mymoney-shell:' + self.registration.scope + ':';
const current = prefix + 'bcb37e0b3ad8744d0c29a171c492ccc56c708e37311eba0be7eb5bf09a850be2';
const urls = new Map(Object.entries(digests).map(([name, hash]) => [new URL(name, self.registration.scope).href, hash]));
self.oninstall = event => event.waitUntil((async () => {
  const cache = await caches.open(current);
  try {
    for (const [url, expected] of urls) {
      const response = await fetch(url, {cache:'no-store', credentials:'omit', redirect:'follow'});
      if (!response.url.startsWith(self.registration.scope) || response.status !== 200) throw Error('程序文件缺失');
      const bytes = await response.clone().arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
      if (actual !== expected) throw Error('程序文件校验失败');
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      await cache.put(url, new Response(bytes,{headers}));
    }
  } catch (error) {
    await caches.delete(current);
    throw error;
  }
})());
self.onactivate = event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith(prefix) && key !== current) await caches.delete(key);
  }
  await self.clients.claim();
})());
self.onfetch = event => {
  if (event.request.method !== 'GET') return;
  let url = event.request.url;
  if (url === self.registration.scope) url = new URL('index.html',url).href;
  for (const page of ['review','operations']) {
    if (url === new URL(page,self.registration.scope).href) url += '.html';
  }
  if (urls.has(url)) event.respondWith(caches.open(current).then(async cache =>
    await cache.match(url) || Response.error()));
};


