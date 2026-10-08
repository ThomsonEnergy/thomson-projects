// Service worker: only here to show push notifications (the lock screen /
// notification shade ones) and open the right page when one is tapped. It does
// no caching, so it can never serve a stale copy of the app.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'Thomson Energy', body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Thomson Energy', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/home.html' },
    });
    try { if (self.navigator && self.navigator.setAppBadge && data.count) await self.navigator.setAppBadge(data.count); } catch (e) { /* not supported here */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/home.html', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if (w.url.startsWith(self.location.origin) && 'focus' in w) {
        try { await w.navigate(target); } catch (e) { /* fall through to focus */ }
        return w.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
