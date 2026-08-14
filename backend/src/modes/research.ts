// === Mode: pesquisa ===
//
// A conversation whose product is a document: an html-explainer file — one
// self-contained HTML page, dark theme, tabbed — that grows with the research
// as the two of you argue it out loud, round by round.
//
// Three decisions in here are not obvious and are worth the lines:
//
//   - `requiresMaterial: false`. Research starts at nothing, like a
//     presentation: the person arrives with a topic, not an artifact. A
//     material is still welcome, and when there is one the model is expected to
//     mine it before going to the web.
//   - `parallelSearches: 6` and `materialFreeTools`. The shared tool allows one
//     web search at a time; this mode dispatches a fan of approved doubts, each
//     becoming its own job card, and web_search has to be free with nothing
//     attached for the microphone to open at all.
//   - The document template is an HTML shell, not markdown. The instructions
//     never carry the shell — the prompt does not pay for the template — so the
//     model is told to preserve it byte-by-byte and edit only the tab bodies.

import type { ModeDefinition, ModePromptContext } from "./types.js";

/**
 * The html-explainer shell the conversation fills in.
 *
 * Adapted from the html-explainer skill template: same skeleton (Bootstrap
 * 5.3.8 pinned by CDN with SRI, highlight.js, dark theme, hash deep-link, copy
 * button, print that opens every tab), with the five fixed tabs a research
 * document is born with. The tabs are born with placeholder copy so the model
 * sees the shape it is expected to grow.
 */
const RESEARCH_TEMPLATE = `<!doctype html>
<!--
  TEMPLATE — documento de pesquisa em HTML de arquivo unico, tema escuro, abas.
  A casca (head, CDN, abas, runtime JS) NAO pode ser quebrada: o assistente
  preserva byte a byte e altera somente o conteudo dos paineis (.tab-pane).
-->
<html lang="pt-BR" data-bs-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Diz ao navegador que a pagina e escura ANTES do CSS carregar: sem flash branco,
     e os controles nativos (scrollbar, select, input) ja nascem escuros. -->
<meta name="color-scheme" content="dark">
<title>Pesquisa</title>

<link rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
      integrity="sha384-sRIl4kxILFvY47J16cr9ZwB07vP4J8+LH7qKQnuqkuIAvNWLzeN8tE5YBujZqJLB"
      crossorigin="anonymous">
<link rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.min.css"
      integrity="sha384-CK2SzKma4jA5H/MXDUU7i1TqZlCFaD4T01vtyDFvPlD97JQyS+IsSh1nI2EFbpyk"
      crossorigin="anonymous">
<link rel="stylesheet"
      href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css"
      integrity="sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH"
      crossorigin="anonymous">

<style>
  /* Todo o CSS do documento cabe aqui. Se precisar de mais que isto, e porque
     existe um utilitario do Bootstrap que resolve — procure antes de escrever. */

  /* Ancora nao fica escondida atras da navbar fixa. */
  [id] { scroll-margin-top: 5rem; }

  /* Bloco de codigo: espaco a direita para o botao de copiar nao cobrir o texto. */
  pre { position: relative; margin-bottom: 1rem; }
  pre code.hljs { padding-right: 4rem; border-radius: var(--bs-border-radius); font-size: .875rem; }

  .copy-btn { position: absolute; top: .5rem; right: .5rem; opacity: .4; transition: opacity .15s; }
  pre:hover .copy-btn, .copy-btn:focus-visible { opacity: 1; }

  /* Abrir o arquivo em #pane-x foca o painel (bom: o leitor de tela cai no conteudo),
     e o outline branco do navegador fica gritante. Anel discreto, do tema, no lugar —
     tirar o indicador por completo quebraria quem navega por teclado. */
  .tab-pane:focus-visible { outline: 0; box-shadow: 0 0 0 .2rem rgba(var(--bs-emphasis-color-rgb), .15); }

  /* Impressao/PDF: abre TODAS as abas, senao o papel sai com uma so. */
  @media print {
    /* .d-print-none do Bootstrap resolve o resto: marque com ela o que e so de tela. */
    .nav-tabs, .copy-btn { display: none !important; }
    .tab-content > .tab-pane { display: block !important; opacity: 1 !important; page-break-inside: avoid; }
    .tab-pane::before { content: attr(data-print-title); display: block;
                        font-size: 1.25rem; font-weight: 600; margin: 1.5rem 0 .5rem; }
  }
</style>
</head>

<body class="bg-body">

<nav class="navbar navbar-expand-lg sticky-top bg-body-tertiary border-bottom">
  <div class="container">
    <span class="navbar-brand fw-semibold"><i class="bi bi-search me-1"></i>Pesquisa</span>
    <span class="navbar-text small text-body-secondary d-none d-md-inline">documento vivo — o assistente escreve aqui durante a conversa</span>
  </div>
</nav>

<main class="container py-4" style="max-width: 60rem">

  <header class="mb-4">
    <h1 class="display-6 fw-semibold">O tema desta pesquisa</h1>
    <p class="lead text-body-secondary">O que foi descoberto, com fonte para cada afirmacao. As abas crescem conforme as rodadas fecham.</p>
    <div class="d-flex flex-wrap gap-2">
      <span class="badge text-bg-secondary">tema</span>
      <span class="badge text-bg-secondary">profundidade</span>
    </div>
  </header>

  <!-- ABAS
       Regras que nao podem ser quebradas:
       · <ul role="tablist"> e cada <button role="tab">
       · button.id  ←→  tabpanel.aria-labelledby
       · button.data-bs-target ←→ #id do tabpanel (e aria-controls com o mesmo id, sem #)
       · exatamente UM botao .active + UM painel .show.active
       Para adicionar uma aba "Rodada N", copie um <li> e um painel inteiro,
       trocando os ids, os aria-* e o rotulo. O Bootstrap ja faz navegacao por
       seta/Home/End no tablist; nao reimplemente. -->
  <ul class="nav nav-tabs" id="doc-tabs" role="tablist">
    <li class="nav-item" role="presentation">
      <button class="nav-link active" id="tab-resumo" data-bs-toggle="tab" data-bs-target="#pane-resumo"
              type="button" role="tab" aria-controls="pane-resumo" aria-selected="true">
        <i class="bi bi-journal-text me-1"></i>Resumo
      </button>
    </li>
    <li class="nav-item" role="presentation">
      <button class="nav-link" id="tab-pontos" data-bs-toggle="tab" data-bs-target="#pane-pontos"
              type="button" role="tab" aria-controls="pane-pontos" aria-selected="false">
        <i class="bi bi-list-check me-1"></i>Pontos levantados
      </button>
    </li>
    <li class="nav-item" role="presentation">
      <button class="nav-link" id="tab-duvidas" data-bs-toggle="tab" data-bs-target="#pane-duvidas"
              type="button" role="tab" aria-controls="pane-duvidas" aria-selected="false">
        <i class="bi bi-question-circle me-1"></i>Duvidas
      </button>
    </li>
    <li class="nav-item" role="presentation">
      <button class="nav-link" id="tab-respostas" data-bs-toggle="tab" data-bs-target="#pane-respostas"
              type="button" role="tab" aria-controls="pane-respostas" aria-selected="false">
        <i class="bi bi-link-45deg me-1"></i>Respostas e fontes
      </button>
    </li>
    <li class="nav-item" role="presentation">
      <button class="nav-link" id="tab-rodadas" data-bs-toggle="tab" data-bs-target="#pane-rodadas"
              type="button" role="tab" aria-controls="pane-rodadas" aria-selected="false">
        <i class="bi bi-arrow-repeat me-1"></i>Rodadas
      </button>
    </li>
  </ul>

  <div class="tab-content border border-top-0 rounded-bottom p-4" id="doc-tabs-content">

    <div class="tab-pane fade show active" id="pane-resumo" role="tabpanel"
         aria-labelledby="tab-resumo" tabindex="0" data-print-title="Resumo">
      <h2 class="h4">O tema e a resposta principal</h2>
      <p>O tema da pesquisa, a profundidade combinada (normal ou profunda) e a resposta principal entram aqui quando a conversa avancar.</p>

      <div class="alert alert-primary d-flex gap-2" role="alert">
        <i class="bi bi-info-circle-fill flex-shrink-0"></i>
        <div><strong>Em uma linha:</strong> a conclusao que a pessoa leva embora.</div>
      </div>
    </div>

    <div class="tab-pane fade" id="pane-pontos" role="tabpanel"
         aria-labelledby="tab-pontos" tabindex="0" data-print-title="Pontos levantados">
      <h2 class="h4">O que a pesquisa acumulou</h2>
      <p>Os pontos levantados rodada a rodada entram aqui — fatos, numeros e ideias, cada um com a fonte [n]. Nada sem fonte vira ponto.</p>
      <ul class="text-body-secondary">
        <li>Primeiro ponto com fonte [n].</li>
        <li>Segundo ponto com fonte [n].</li>
      </ul>
    </div>

    <div class="tab-pane fade" id="pane-duvidas" role="tabpanel"
         aria-labelledby="tab-duvidas" tabindex="0" data-print-title="Duvidas">
      <h2 class="h4">O que o material nao respondeu</h2>
      <p>As duvidas que as buscas nao responderam entram aqui, no maximo 3 a 5 por rodada. Cada duvida aprovada vira uma busca nova na rodada seguinte.</p>
    </div>

    <div class="tab-pane fade" id="pane-respostas" role="tabpanel"
         aria-labelledby="tab-respostas" tabindex="0" data-print-title="Respostas e fontes">
      <h2 class="h4">Respostas e a tabela de fontes</h2>
      <p>As respostas obtidas entram aqui, cada uma citada com a fonte [n], e a tabela abaixo relaciona [n] ao titulo, a URL e a data.</p>
      <div class="table-responsive">
        <table class="table table-striped align-middle">
          <thead>
            <tr><th scope="col">#</th><th scope="col">Fonte</th><th scope="col">Data</th></tr>
          </thead>
          <tbody>
            <tr><td>[1]</td><td>Titulo da fonte — URL</td><td>data</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="tab-pane fade" id="pane-rodadas" role="tabpanel"
         aria-labelledby="tab-rodadas" tabindex="0" data-print-title="Rodadas">
      <h2 class="h4">O historico das rodadas</h2>
      <p>O resumo de cada rodada entra aqui quando ela fechar: o que foi buscado, o que foi encontrado e o que ficou em aberto. O assistente adiciona uma aba propria para cada rodada.</p>
    </div>

  </div>

  <footer class="text-body-secondary small border-top mt-5 pt-3">
    Documento de arquivo unico — salve, mande por anexo, abra offline.
  </footer>

</main>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/js/bootstrap.bundle.min.js"
        integrity="sha384-FKyoEForCGlyvwx9Hj09JcYn3nv7wiPVlz7YYwJrWVcXK/BmnVDxM+D2scQbITxI"
        crossorigin="anonymous"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"
        integrity="sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU"
        crossorigin="anonymous"></script>

<script>
/* ── runtime do documento ────────────────────────────────────────────────────
   Copie este bloco inteiro, sem editar. Ele faz tres coisas:
   1. guarda o codigo-fonte cru ANTES de qualquer transformacao (para o copiar);
   2. destaca a sintaxe e injeta o botao de copiar;
   3. liga as abas ao #hash da URL, nos dois sentidos.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // 1. Fonte cru primeiro. Depois do highlight o DOM ganha <span>; textContent ainda
  //    devolve o texto certo, mas plugins de numeracao de linha o contaminam. Guardar
  //    antes e a unica versao que nunca mente.
  var sources = new WeakMap();
  document.querySelectorAll('pre > code').forEach(function (code) {
    sources.set(code, code.textContent.replace(/\\n$/, ''));
  });

  // 2. Highlight. Declare sempre a linguagem na classe: a auto-deteccao erra em
  //    trechos curtos (o mesmo snippet vira "ruby" numa aba e "perl" na outra).
  if (window.hljs) hljs.highlightAll();

  // Copiar. navigator.clipboard exige contexto seguro; em file:// o comportamento
  // varia por navegador, entao o fallback com execCommand nao e opcional.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
                                                      function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // position:fixed + opacity:0 evita que a pagina role ate o textarea.
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length); // iOS ignora select() sozinho
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  document.querySelectorAll('pre > code').forEach(function (code) {
    var pre = code.parentElement;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-outline-secondary copy-btn';
    btn.innerHTML = '<i class="bi bi-clipboard"></i>';
    btn.setAttribute('aria-label', 'Copiar codigo');
    btn.addEventListener('click', function () {
      copyText(sources.get(code) || code.textContent).then(function (ok) {
        btn.innerHTML = ok ? '<i class="bi bi-check-lg"></i>' : '<i class="bi bi-x-lg"></i>';
        btn.classList.toggle('btn-outline-success', ok);
        btn.classList.toggle('btn-outline-danger', !ok);
        btn.classList.remove('btn-outline-secondary');
        setTimeout(function () {
          btn.innerHTML = '<i class="bi bi-clipboard"></i>';
          btn.className = 'btn btn-sm btn-outline-secondary copy-btn';
        }, 1500);
      });
    });
    pre.appendChild(btn);
  });

  // 3. Aba ↔ URL. Sem isto, mandar "olha a aba Duvidas" exige explicar o clique.
  var tabs = document.querySelectorAll('[data-bs-toggle="tab"]');
  if (!tabs.length) return;

  function activateFromHash() {
    var hash = window.location.hash;
    if (!hash || hash.length < 2) return;
    var target = document.querySelector(hash);
    if (!target) return;
    // O #hash pode apontar para o painel OU para um titulo dentro dele.
    var pane = target.closest('.tab-pane') || (target.classList.contains('tab-pane') ? target : null);
    if (!pane) return;
    var trigger = document.querySelector('[data-bs-target="#' + CSS.escape(pane.id) + '"]');
    if (trigger) bootstrap.Tab.getOrCreateInstance(trigger).show();
    // O navegador ja tentou rolar ate o alvo — e falhou, porque naquele instante o
    // painel ainda era display:none. Agora que apareceu, role de novo: sem isto a
    // pagina abre num scroll intermediario, com as abas escondidas atras da navbar.
    var scrollTo = target !== pane ? target : (trigger && trigger.closest('[role="tablist"]')) || pane;
    requestAnimationFrame(function () { scrollTo.scrollIntoView({ block: 'start' }); });
  }

  tabs.forEach(function (t) {
    t.addEventListener('shown.bs.tab', function (e) {
      var id = (e.target.getAttribute('data-bs-target') || '').slice(1);
      // replaceState, nao location.hash: mudar o hash direto faz a pagina pular.
      if (id) history.replaceState(null, '', '#' + id);
    });
  });

  window.addEventListener('hashchange', activateFromHash);
  activateFromHash();
})();
</script>
</body>
</html>
`;

/**
 * How the model is told to use the document.
 *
 * Separate from the flow because this is about *this application* — which tool
 * touches what — while the flow is about the research protocol and would be
 * true in any product. The shell is never embedded here: the instructions are
 * re-billed on every response, and the template does not pay for itself twice.
 */
function documentSection(): string {
  return `# O documento — a coluna da direita
- O documento e UM ARQUIVO HTML (formato html-explainer: tema escuro, abas, arquivo unico), NAO um markdown. Ele fica na tela da pessoa e E O PRODUTO DESTA CONVERSA. Uma conversa boa que nao deixou o documento pronto falhou.
- Leia com read_document ANTES de reescrever qualquer parte que voce nao acabou de escrever. A pessoa pode ter editado.
- Reescreva com write_document preservando a casca BYTE-A-BYTE: o <head> e os links CDN (com integrity), a lista de abas, o runtime JS no fim do arquivo e os atributos aria-*. Altere SOMENTE o conteudo dos paineis (.tab-pane).
- NAO use edit_document_section para o HTML: ela entende secoes markdown, e o HTML e uma secao unica.
- Quando uma rodada fechar, escreva o resumo dela na aba 'Rodadas' e adicione uma aba NOVA 'Rodada N' copiando a estrutura de um painel existente (botao na lista de abas + painel correspondente, com os mesmos atributos aria-*).
- O resumo de CADA rodada tem: pontos levantados (acumulado), duvidas levantadas e respostas com fontes [n]. A tabela de fontes fica no fim da aba 'Respostas e fontes'.
- NUNCA quebre a casca. Se a pessoa editou o documento, leia antes e preserve o que ela escreveu.`;
}

function researchSection(context: ModePromptContext): string {
  const lines = [
    "# Pesquisa",
    "- Numero, fato, data e nome que voce nao tem: PESQUISE antes de escrever no documento. Fato inventado destroi a pesquisa inteira.",
    "- Toda afirmacao do documento vem com a fonte [n]; a tabela de fontes no fim da aba 'Respostas e fontes' relaciona [n] ao titulo, a URL e a data. Sem fonte, nao escreva como fato.",
    "- web_search responde NA HORA que a busca comecou; o resultado chega sozinho depois. Enquanto roda, CONTINUE conversando — nunca fique em silencio esperando.",
    "- Pesquise SO as duvidas que a pessoa aprovou. Uma busca que ninguem pediu e custo sem resposta.",
    "- check_web_search so quando a pessoa perguntar como esta uma busca.",
  ];

  if (context.sources.length > 0) {
    lines.push(
      "- Esta conversa TEM material anexado. Antes de pesquisar na internet, procure a evidencia nele: e o material da pessoa que da autoridade a pesquisa.",
    );
  }

  return lines.join("\n");
}

export const RESEARCH_MODE: ModeDefinition = {
  id: "research",
  label: "Pesquisa",
  description:
    "Pesquise um tema por voz, com rodadas de busca aprovadas por você, e leve um documento HTML com abas, respostas e fontes.",
  icon: "Compass",
  requiresMaterial: false,

  // Research dispatches a fan of approved doubts, each becoming its own job
  // card, and web_search has to be free with no material attached — this mode
  // opens the microphone on an empty conversation.
  parallelSearches: 6,
  materialFreeTools: ["web_search", "check_web_search"],

  document: {
    title: "Pesquisa",
    placeholder:
      "A pesquisa aparece aqui num documento HTML — resumo, pontos levantados, duvidas, respostas com fontes e o historico de rodadas.",
    template: RESEARCH_TEMPLATE,
    openByDefault: true,
    format: "html",
  },

  toolNames: [
    "read_document",
    "write_document",
    "append_document",
    "edit_document_section",
    "web_search",
    "check_web_search",
  ],

  role: `# Role & Objective
- Voce e um pesquisador de voz conversando com uma pessoa sobre um tema que ela escolher.
- O produto desta conversa e UM DOCUMENTO: a pesquisa organizada num arquivo HTML de abas — resumo, pontos levantados, duvidas, respostas com fontes e rodadas — pronto para a pessoa levar embora.
- Sucesso NAO e concordar com a pessoa nem responder rapido. Sucesso e a pesquisa ficar completa: cada afirmacao apoiada por uma fonte e cada duvida resolvida ou explicitamente deixada em aberto.
- NUNCA invente fato, numero ou fonte. Se a busca nao trouxe, diga que nao trouxe.`,

  flow: `# Conversation Flow
1. Abertura: o usuario diz o tema. REPITA o tema em uma frase e faca UMA pergunta de abertura: a profundidade esperada e normal ou profunda.
2. RODADA 1 — PESQUISA AMPLA: dispare 1 a 3 buscas web para mapear o assunto (web_search; cada busca vira um cartao com indicador na tela). Enquanto as buscas rodam, CONTINUE a conversa — fale sobre o tema, pergunte o que a pessoa quer saber primeiro.
3. COM OS RESULTADOS, levante as DUVIDAS: liste em voz alta as perguntas que o material nao respondeu — no maximo 3 a 5 por rodada.
4. PECA APROVACAO: o usuario escolhe quais duvidas viram buscas novas. PESQUISE SO AS APROVADAS.
5. PARALELIZE: dispare UMA busca web por duvida aprovada, todas AO MESMO TEMPO. Nesta conversa varias buscas simultaneas sao permitidas; cada uma vira um cartao proprio com estado.
6. CADA RODADA TERMINADA: escreva no documento o RESUMO DA RODADA — pontos levantados (acumulado), duvidas levantadas, respostas obtidas com fontes [n] — e anuncie o resumo em voz alta em 2-3 frases.
7. REPITA: com o material novo, levante novas duvidas, peca aprovacao e paralelize. O ciclo continua ate o usuario dizer que esta bom. Entao feche: resumo final no documento e em voz, e a secao 'Para saber mais' com 2-3 sugestoes de continuacao.`,

  // Both sections are gated on the tools actually minted with the session: the
  // preamble forbids naming a tool the model was not given. The shell lives in
  // the template only — embedding it here would bill it again on every turn.
  sections: (context) => [
    ...(context.toolNames.includes("write_document") ? [documentSection()] : []),
    ...(context.toolNames.includes("web_search") ? [researchSection(context)] : []),
  ],

  greeting: () => "Vamos pesquisar. Conecte e me diga o tema da pesquisa.",
};
