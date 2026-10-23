/* Service worker compartido por la Biblioteca, el Generador y el Reproductor.
 *
 * Debe estar en la MISMA carpeta que el HTML (como favicon.ico). Se puede copiar tal cual a la
 * carpeta de cada página: cada una guarda su propia copia, separada por su ámbito.
 *
 *  - Páginas y archivos propios: primero la red, y si falla (o tarda más de 4 s y ya hay copia
 *    guardada) se usa la copia del dispositivo. Con conexión siempre se ve la versión nueva.
 *  - Tipografías de Google Fonts: primero la copia, y se actualiza en segundo plano.
 *  - No toca nada más: los datos del Apps Script, los POST y los iframes de Drive van directos a la red.
 *  - La primera visita no puede funcionar sin conexión (aún no hay nada guardado): la propia página
 *    pide aquí que se guarde (mensaje «guardar») en cuanto el service worker está activo.
 *
 * Si algún día cambia la estructura de lo guardado, sube VERSION para empezar con la caché limpia.
 */
var VERSION = 'v1';
var PREFIJO = 'natacion:' + self.registration.scope + ':';
var CACHE = PREFIJO + VERSION;
var ESPERA_RED = 4000;                                   // ms
var FUENTES = ['fonts.googleapis.com', 'fonts.gstatic.com'];
var MAX_URLS = 20, MAX_FUENTES = 30;

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (claves) {
      return Promise.all(claves.filter(function (k) { return k.indexOf(PREFIJO) === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function esFuente(u) { return FUENTES.indexOf(u.hostname) >= 0; }
function esPropio(u) { return u.origin === self.location.origin; }
// Las páginas y los archivos propios se guardan sin «?…», para que ?x=1 y ?x=2 usen la misma copia.
function claveDe(u) { return esPropio(u) ? u.origin + u.pathname : u.href; }
function nada() {}

function sinConexion() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Sin conexión</title><body style="font-family:sans-serif;padding:2rem;line-height:1.5">' +
    '<h1>Sin conexión</h1><p>Esta página todavía no está guardada en el dispositivo. Ábrela una vez con conexión y la próxima vez funcionará sin ella.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Propios: red primero, copia de respaldo.
function redLuegoCache(req, terminar) {
  var u = new URL(req.url), nav = req.mode === 'navigate';
  var guardable = nav || !u.search;
  var clave = claveDe(u);
  return caches.open(CACHE).then(function (cache) {
    return cache.match(clave, { ignoreSearch: nav }).then(function (guardada) {
      var red = fetch(req);
      red.then(function (resp) {
        if (guardable && resp && resp.ok && resp.type === 'basic') return cache.put(clave, resp.clone());
      }).catch(nada).then(function () { terminar(); });
      if (!guardada) return red.catch(function () { return nav ? sinConexion() : Response.error(); });
      var tope = new Promise(function (r) { setTimeout(function () { r(null); }, ESPERA_RED); });
      return Promise.race([red, tope]).then(function (resp) { return resp || guardada; }, function () { return guardada; });
    });
  });
}

// Tipografías: copia primero, y se refresca en segundo plano.
function cacheLuegoRed(req, terminar) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req.url).then(function (guardada) {
      var red = fetch(req);
      red.then(function (resp) {
        if (resp && (resp.ok || resp.type === 'opaque')) return cache.put(req.url, resp.clone());
      }).catch(nada).then(function () { terminar(); });
      return guardada || red;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  var fuente = esFuente(u);
  if (!esPropio(u) && !fuente) return;
  var terminar, fin = new Promise(function (r) { terminar = r; });
  e.waitUntil(fin);
  e.respondWith((fuente ? cacheLuegoRed : redLuegoCache)(req, terminar).catch(function (err) { terminar(); throw err; }));
});

/* ---- «guardar»: la página pide guardar ahora lo suyo (necesario en la primera visita) ---- */
function guardarUrl(cache, s, yaGuardadas) {
  var u;
  try { u = new URL(s, self.location.href); } catch (x) { return Promise.resolve(); }
  if (!/^https?:$/.test(u.protocol)) return Promise.resolve();
  u.hash = '';
  var fuente = esFuente(u);
  if (!esPropio(u) && !fuente) return Promise.resolve();
  var clave = claveDe(u);
  return cache.match(clave).then(function (ya) {
    if (ya) return;
    return fetch(u.href).then(function (resp) {
      if (!resp || !(resp.ok || resp.type === 'opaque')) return;
      var copia = resp.clone();
      return cache.put(clave, resp).then(function () {
        // Hoja de estilos de Google Fonts: se guardan también los archivos de letra que enlaza.
        if (u.hostname !== 'fonts.googleapis.com' || !copia.ok) return;
        return copia.text().then(function (css) {
          var tipos = [], m, re = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/g;
          while ((m = re.exec(css)) && tipos.length < MAX_FUENTES) if (tipos.indexOf(m[1]) < 0) tipos.push(m[1]);
          return Promise.all(tipos.map(function (t) { return guardarUrl(cache, t, yaGuardadas); }));
        });
      });
    }).catch(nada);
  });
}

self.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.tipo !== 'guardar' || !Array.isArray(d.urls)) return;
  e.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(d.urls.slice(0, MAX_URLS).map(function (s) { return guardarUrl(cache, s); }));
  }).catch(nada));
});
