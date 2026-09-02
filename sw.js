/**
 * =============================================================
 *  ObraFlow — Grupo SR
 *  Service worker: o app abre sem sinal e se atualiza sozinho.
 * =============================================================
 *
 * Como funciona, em uma frase por caso:
 *
 *   • Tela do app (navegação) -> REDE PRIMEIRO. Se a rede responder,
 *     é a versão nova que aparece e ela é guardada. Se não responder,
 *     entra a última versão guardada. É isso que faz o supervisor
 *     receber uma publicação nova sem precisar de Ctrl+Shift+R.
 *
 *   • Arquivos do app (CSS, JS, ícones, logo) -> CACHE PRIMEIRO, com
 *     atualização por trás. Abre instantâneo e, no mesmo acesso,
 *     baixa a versão nova para a próxima vez.
 *
 *   • Apps Script (busca de item, cronograma, pedidos) -> NUNCA
 *     guardado. Vai sempre à rede, para não existir a chance de
 *     mostrar dado velho da planilha.
 *
 * Para forçar a limpeza do cache antigo em todos os celulares,
 * troque o número de CACHE_VERSION abaixo e publique. No dia a dia
 * isso não é necessário — a tela do app já é rede-primeiro.
 */

const CACHE_VERSION = "v12";
const CACHE_NAME = "obraflow-" + CACHE_VERSION;

// Arquivos que o app precisa para abrir sem internet.
// Caminhos relativos ao próprio sw.js, então funcionam em
// /Localizador-de-Itens/ sem eu precisar escrever o repositório.
const ARQUIVOS_DO_APP = [
  "./",
  "./index.html",
  "./manifest.json",
  "./sr-sem-fundo.png",
  "./fundo-topo.png",
  "./favicon.ico",
  "./icon-192.png",
  "./icon-512.png"
];

// Bibliotecas externas que valem a pena guardar: sem elas a tela fica
// sem estilo (Tailwind), o PDF do checklist não gera (pdf-lib) e o
// leitor de código de barras não abre (ZXing, no unpkg).
//
// O unpkg entrou depois: a biblioteca do leitor tem ~200 KB e era
// baixada de novo a cada recarga do app. Com sinal fraco no galpão,
// era a diferença entre a câmera abrir e não abrir.
const CDNS_PERMITIDAS = [
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "unpkg.com"
];

/**
 * As que são BAIXADAS JÁ NA INSTALAÇÃO.
 *
 * Antes elas só entravam no cache depois de o navegador buscá-las uma
 * vez com sucesso. Na prática dava certo quase sempre — mas "quase"
 * não serve para o checklist: se a instalação pegasse um sinal ruim e
 * o pdf-lib não descesse, o supervisor só ia descobrir no galpão, sem
 * internet, na hora de gerar o PDF.
 *
 * Agora a instalação busca as três. Se alguma falhar, o resto segue —
 * e ela ainda pode ser guardada depois, pelo caminho normal.
 */
const BIBLIOTECAS = [
  "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
  "https://cdn.tailwindcss.com",
  "https://unpkg.com/@zxing/browser@0.2.1/umd/zxing-browser.min.js",
  // O visualizador de desenho. São 1,4 MB (320 KB + 1,1 MB do
  // "worker"), e eles eram baixados na PRIMEIRA vez que alguém tocava
  // em "Abrir Desenho" — no meio do galpão, com sinal fraco, isso
  // sozinho eram uns 7 segundos de espera antes de o desenho começar
  // a aparecer. E offline, num aparelho que nunca tinha aberto um
  // desenho, o visualizador simplesmente não subia.
  // Agora descem na instalação, junto com o resto.
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
];

// Endereços que NUNCA entram no cache — são dados, não arquivos.
const SEM_CACHE = [
  "script.google.com",
  "script.googleusercontent.com"
];

/* ============================================================
   INSTALAÇÃO — guarda os arquivos do app
============================================================ */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Um a um, e não addAll: se um arquivo faltar no repositório
      // (um ícone que ainda não foi enviado, por exemplo), o resto
      // continua sendo guardado em vez de a instalação inteira falhar.
      const doApp = ARQUIVOS_DO_APP.map((caminho) =>
        cache.add(new Request(caminho, { cache: "reload" }))
          .catch((err) => console.warn("[sw] não guardei", caminho, err))
      );
      /* As bibliotecas vêm de outro endereço. Tento primeiro do jeito
         normal, que permite conferir a resposta; se a CDN não autorizar,
         caio no modo "no-cors", em que a resposta é opaca — o navegador
         não me deixa ler, mas serve para devolver o arquivo depois. */
      const deFora = BIBLIOTECAS.map((url) =>
        fetch(new Request(url, { cache: "reload" }))
          .then((r) => {
            if (!r || !r.ok) throw new Error("status " + (r && r.status));
            return cache.put(url, r.clone());
          })
          .catch(() =>
            fetch(new Request(url, { mode: "no-cors", cache: "reload" }))
              .then((r) => cache.put(url, r.clone()))
          )
          .catch((err) => console.warn("[sw] não guardei a biblioteca", url, err))
      );
      return Promise.all(doApp.concat(deFora));
    })
  );
  self.skipWaiting();
});

/* ============================================================
   ATIVAÇÃO — apaga os caches de versões anteriores
============================================================ */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes
          .filter((n) => n.startsWith("obraflow-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* ============================================================
   REQUISIÇÕES
============================================================ */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // POST e afins (envio de formulário, Asana) passam direto.
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }

  // Só http/https — extensões do navegador ficam de fora.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Dados da planilha: sempre rede, nunca cache.
  if (SEM_CACHE.indexOf(url.hostname) >= 0) return;

  // A tela do app: rede primeiro, cache como rede de segurança.
  if (req.mode === "navigate") {
    event.respondWith(redePrimeiro(req));
    return;
  }

  const mesmaOrigem = url.origin === self.location.origin;
  const cdnConhecida = CDNS_PERMITIDAS.indexOf(url.hostname) >= 0;

  if (mesmaOrigem || cdnConhecida) {
    event.respondWith(cachePrimeiro(req));
  }
  // Qualquer outro endereço (a logo do GitHub usada no PDF, por
  // exemplo) segue o caminho normal, sem o service worker no meio.
});

/**
 * Rede primeiro. Usado na tela do app: garante que uma publicação
 * nova apareça assim que houver sinal. Sem sinal, devolve a última
 * versão guardada; e se nem isso existir, a página inicial.
 */
function redePrimeiro(req) {
  return fetch(req)
    .then((resposta) => {
      if (resposta && resposta.ok) {
        const copia = resposta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
      }
      return resposta;
    })
    .catch(() => {
      return caches.match(req)
        .then((guardada) => guardada || caches.match("./index.html"))
        .then((guardada) => guardada || caches.match("./"))
        .then((guardada) => guardada || respostaSemConexao());
    });
}

/**
 * Cache primeiro, atualizando por trás. A tela aparece na hora com
 * o que já está guardado, e a versão nova do arquivo é baixada em
 * silêncio para o próximo acesso.
 */
function cachePrimeiro(req) {
  return caches.match(req).then((guardada) => {
    const daRede = fetch(req)
      .then((resposta) => {
        // Resposta opaca (CDN sem CORS) tem status 0 e não dá para
        // conferir — guardo assim mesmo, é o que o navegador permite.
        if (resposta && (resposta.ok || resposta.type === "opaque")) {
          const copia = resposta.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copia));
        }
        return resposta;
      })
      .catch(() => guardada);

    return guardada || daRede;
  });
}

/** Última linha de defesa: sem rede e sem nada guardado. */
function respostaSemConexao() {
  return new Response(
    "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>Sem conexão</title></head>" +
    "<body style=\"font-family:system-ui,sans-serif;background:#1a1a1a;" +
    "color:#e0e0e0;display:flex;align-items:center;justify-content:center;" +
    "height:100vh;margin:0;text-align:center;padding:24px\">" +
    "<div><h1 style='color:#4ade80;font-size:18px;margin:0 0 8px'>Sem conexão</h1>" +
    "<p style='color:#9ca3af;font-size:14px;margin:0'>Abra o aplicativo uma vez " +
    "com internet para ele funcionar offline depois.</p></div></body></html>",
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
