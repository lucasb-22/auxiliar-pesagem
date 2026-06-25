/*
 * Service Worker - App de Pesagem PWA
 * Versão: v1.0.0
 * Otimizado para: funcionamento offline + comunicação Bluetooth (BLE)
 * Estratégia: Precache em install + stale-while-revalidate + network-first para navegação
 */

const CACHE_VERSION = 'v1.0.0';
const CACHE_NAME = `weighing-app-${CACHE_VERSION}`;
const STATIC_CACHE = `weighing-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE = `weighing-dynamic-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  '/css/styles.css',
  '/css/app.css',
  '/js/app.js',
  '/js/main.js',
  '/js/bluetooth.js',
  '/js/weighing.js',
  '/js/storage.js',
  '/images/logo-192x192.png',
  '/images/logo-512x512.png',
  '/images/favicon.ico',
  '/images/icon-ble.svg',
  '/images/icon-weight.svg',
  '/images/offline.svg'
];

const OFFLINE_PAGE = '/offline.html';

// URLs que NUNCA devem ser interceptadas/cacheadas (comunicação BLE/REST)
const NETWORK_ONLY_PREFIXES = [
  '/api/',
  '/ble/',
  '/weight/',
  '/sync/',
  'https://api.',
  'bluetooth://'
];

const NETWORK_ONLY_PATTERNS = [
  /^ws:\/\//,
  /^wss:\/\//
];

// ============================================================
// INSTALAÇÃO: cache de todos os assets na primeira abertura
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando versão', CACHE_VERSION);

  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(async (cache) => {
        // Cacheia cada asset individualmente para evitar falha total
        const promises = STATIC_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, {
              cache: 'no-cache',
              credentials: 'same-origin'
            });
            if (response && response.ok) {
              await cache.put(url, response);
              console.log('[SW] Cacheado:', url);
            } else {
              console.warn('[SW] Resposta inválida para:', url);
            }
          } catch (err) {
            console.warn(`[SW] Não foi possível cachear ${url}:`, err);
          }
        });
        await Promise.all(promises);
      })
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.error('[SW] Erro durante instalação:', err);
      })
  );
});

// ============================================================
// ATIVAÇÃO: limpa caches antigos e assume controle imediato
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Ativando versão', CACHE_VERSION);

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (
              cacheName !== STATIC_CACHE &&
              cacheName !== DYNAMIC_CACHE
            ) {
              console.log('[SW] Removendo cache antigo:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
      .catch((err) => console.error('[SW] Erro ao limpar caches:', err))
  );
});

// ============================================================
// HELPERS
// ============================================================
function isNetworkOnlyRequest(url) {
  const urlString = url.toString();
  return NETWORK_ONLY_PREFIXES.some((prefix) =>
    urlString.startsWith(prefix)
  ) || NETWORK_ONLY_PATTERNS.some((pattern) => pattern.test(urlString));
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

function isStaticAsset(request) {
  const dest = request.destination;
  return (
    dest === 'style' ||
    dest === 'script' ||
    dest === 'image' ||
    dest === 'font' ||
    dest === 'manifest' ||
    /\.(css|js|png|jpg|jpeg|svg|gif|webp|ico|woff|woff2|ttf|otf|json)$/i.test(request.url)
  );
}

async function sendMessageToClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => {
    client.postMessage(message);
  });
}

// ============================================================
// FETCH: intercepta requisições e serve offline quando necessário
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Não interceptar requisições de outros domínios (a menos que permitido)
  if (url.origin !== self.location.origin && !isStaticAsset(request)) {
    return;
  }

  // Ignorar requisições não GET
  if (request.method !== 'GET') {
    return;
  }

  // Requisições de rede exclusiva (Bluetooth/API/web sockets) não devem passar pelo cache
  if (isNetworkOnlyRequest(url)) {
    console.log('[SW] Network only:', request.url);
    return;
  }

  // Navegação: tenta rede primeiro, depois cache, depois página offline
  if (isNavigationRequest(request)) {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  // Assets estáticos: cache primeiro, atualiza em background se houver conexão
  if (isStaticAsset(request)) {
    event.respondWith(cacheFirstWithRevalidate(request));
    return;
  }

  // Outras requisições: cache first genérico
  event.respondWith(cacheFirstOrFetch(request));
});

async function networkFirstWithOfflineFallback(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE);
      await cache.put(request, networkResponse.clone());
      return networkResponse;
    }
    throw new Error('Resposta da rede inválida');
  } catch (err) {
    console.warn('[SW] Navegação offline, buscando cache:', request.url, err);
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    // Fallback para página offline
    const offlineResponse = await caches.match(OFFLINE_PAGE);
    if (offlineResponse) {
      return offlineResponse;
    }
    // Último recurso: resposta HTML genérica
    return new Response(
      '<html><body><h1>Você está offline</h1><p>Conecte-se à internet para continuar.</p></body></html>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function cacheFirstWithRevalidate(request) {
  const cachedResponse = await caches.match(request);

  if (cachedResponse) {
    // Atualiza em background (stale-while-revalidate) quando há conexão
    if (self.navigator && self.navigator.onLine) {
      fetch(request)
        .then(async (networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const cache = await caches.open(STATIC_CACHE);
            await cache.put(request, networkResponse.clone());
            console.log('[SW] Cache atualizado em background:', request.url);
          }
        })
        .catch((err) => {
          console.warn('[SW] Falha ao revalidar cache:', request.url, err);
        });
    }
    return cachedResponse;
  }

  // Se não está no cache, tenta buscar na rede
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    console.warn('[SW] Recurso indisponível offline:', request.url, err);
    return new Response('Recurso offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function cacheFirstOrFetch(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  try {
    return await fetch(request);
  } catch (err) {
    console.warn('[SW] Falha ao buscar recurso:', request.url, err);
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ============================================================
// ATUALIZAÇÃO DO CACHE QUANDO HÁ CONEXÃO
// ============================================================
async function updateCacheInBackground() {
  if (!self.navigator || !self.navigator.onLine) {
    console.log('[SW] Offline: não é possível atualizar cache agora.');
    return;
  }

  console.log('[SW] Atualizando cache em background...');
  try {
    const cache = await caches.open(STATIC_CACHE);
    const promises = STATIC_ASSETS.map(async (url) => {
      try {
        const networkResponse = await fetch(url, {
          cache: 'no-cache',
          credentials: 'same-origin'
        });
        if (networkResponse && networkResponse.ok) {
          await cache.put(url, networkResponse);
        }
      } catch (err) {
        console.warn('[SW] Falha ao atualizar:', url, err);
      }
    });
    await Promise.all(promises);
    await sendMessageToClients({ type: 'CACHE_UPDATED', version: CACHE_VERSION });
    console.log('[SW] Cache atualizado com sucesso.');
  } catch (err) {
    console.error('[SW] Erro ao atualizar cache:', err);
  }
}

// ============================================================
// MENSAGENS: comunicação entre app e service worker
// ============================================================
self.addEventListener('message', (event) => {
  if (!event.data) return;

  const { type, payload } = event.data;

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'UPDATE_CACHE':
      event.waitUntil(updateCacheInBackground());
      break;

    case 'CLEAR_CACHE':
      event.waitUntil(
        caches.keys().then((cacheNames) => {
          return Promise.all(cacheNames.map((name) => caches.delete(name)));
        })
      );
      break;

    case 'WEIGHING_DATA_SYNC':
      // App pode enviar dados de pesagem para sincronização quando voltar online
      console.log('[SW] Dados de pesagem recebidos para sync:', payload);
      break;

    default:
      console.log('[SW] Mensagem desconhecida:', type);
  }
});

// ============================================================
// BACKGROUND SYNC: tenta sincronizar quando a conexão retorna
// ============================================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-weighing-data') {
    event.waitUntil(
      sendMessageToClients({ type: 'SYNC_REQUIRED', tag: event.tag })
    );
  }
});

// ============================================================
// NOTIFICAÇÃO DE ESTADO DE CONEXÃO
// ============================================================
self.addEventListener('online', () => {
  console.log('[SW] Conexão detectada. Cache será revalidado.');
  sendMessageToClients({ type: 'ONLINE', version: CACHE_VERSION });
  updateCacheInBackground();
});

self.addEventListener('offline', () => {
  console.log('[SW] Modo offline detectado.');
  sendMessageToClients({ type: 'OFFLINE', version: CACHE_VERSION });
});

console.log('[SW] Service Worker v1.0.0 carregado.');
