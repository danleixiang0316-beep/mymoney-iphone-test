'use strict';
const digests = {"app.webmanifest":"fea815cb5c9cf71e796ce82fcb39a42a2fc04e69ad64916dbecca08aecd3351f","home.css":"1dab22d051ce6fb184744f8d8d2f8bb707346eb74c5a931d86dc2c6d042a17f1","home.js":"b46a4eccccbc83721509e88ed5c1dfea485f2621aa3db5fc6e6e99270e6d6f25","icon-180.png":"0506fb487f056b02611a90391353fd5a5ac26bb0edf3e4f8c66b02656527e156","icon-192.png":"5cd91df8f2082224ab2b534232283eb69b505b308b148dc72b309ff238cce683","icon-512.png":"7bdb83d8bee5541de07ac111f1eb54f537aa89c48820145d463008f1e5589e7c","import.css":"91a3e857ccacecd836857df8ef9ad9c16f41761e7dac92d6c4c4c71ed8d491cf","index.html":"f950c18ffd5ee8da74b6b4250c16299a17bdff730bef30d8af4a4baf783c1ac5","mobile.css":"1528cddb3e3098c638a6eed530ef919aa50b5d70b44f2b0cf93ca82cdf9b92f4","operations.html":"6f06aad64c654cb402a3ac5ca2b0f7ddc222182c0aa37605629577087fe53cb5","operations.js":"5f7a9de7aeb58fd69e19bdabfe9dd7a3389ac5e18949c900cd9bf438f0bec4e7","review.html":"758a5b167bd4b5ab507b36f92a5ac7aedf57b968d9d208a7656ec274e13e15d5","review.js":"adf402e63deb484b40dd075a33c3d319c514c6fdfb9fa8fb113460bba3108cae","rules.js":"2360e1d0dbee1a2f53ecd237b2907ccd0dfa2b232ae2daff9c9f7738f567c253","start.js":"fad3cba33900cce605cdc1d79b94de05e0cc490b974039a70aed9a38aa2404fc","store.js":"3634695774266c356fab119f429bb9ff67ad2a93061fcea86c009f784c14dd26","style.css":"1db4e880f10865039c2e229d410487b64d1446497603422937f50f0d25d6806e","zip-native.js":"7aa2bc2b36ca40443ef1ed5d95a1db9430e476fde047ab61152220affd63ff2c"};
const prefix = 'mymoney-shell:' + self.registration.scope + ':';
const current = prefix + 'cbf00071e4d2dc1bc190384b7cdc5f2fab7a55d086df342f6f8ef6b6b421471a';
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


