// Notificação do lembrete "como o carro andou?" (Web Push sem conteúdo: o texto é sempre este).
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Como o carro andou?', {
      body: 'Faz uma semana do último abastecimento. Conte o que achou do combustível — leva 2 segundos.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: 'encheai-depois',
      data: { url: self.registration.scope + '#/inicio' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
