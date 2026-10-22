import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// O GitHub Pages serve o app em /encheai/
const base = process.env.BASE_PATH ?? '/encheai/';
const build = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  base,
  define: { __BUILD__: JSON.stringify(build) },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Enche AI',
        short_name: 'Enche AI',
        description: 'Saiba em qual posto vale abastecer, medido por quem abastece lá.',
        lang: 'pt-BR',
        // identidade própria do app instalado (separada de instalações antigas e do app anterior)
        id: base + 'app',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0E3B2E',
        theme_color: '#0E3B2E',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: base + 'index.html',
        cleanupOutdatedCaches: true,
        // notificações do lembrete "como o carro andou?" (public/push-sw.js)
        importScripts: ['push-sw.js'],
        // Lista de postos (atualizada toda semana): abre na hora com a cópia do celular e atualiza por trás
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/dados\/postos-[A-Z-]+\.json$/.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'postos', expiration: { maxEntries: 4 } },
          },
        ],
      },
    }),
  ],
});
