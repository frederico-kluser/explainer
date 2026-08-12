// === Mode: criar apresentação ===
//
// A conversation whose product is a document: the full script of a talk, slide
// by slide, written while the two of you argue about it out loud.
//
// Two decisions in here are not obvious and are worth the lines:
//
//   - `requiresMaterial: false`. Every other conversation in this app starts by
//     pointing at something. A presentation usually starts at nothing — the
//     person has a talk to give and no artifact yet — so this is the first mode
//     that has to open the microphone on an empty conversation. A material is
//     still welcome, and when there is one the model is expected to mine it for
//     evidence rather than invent numbers.
//   - The document template ships filled with headings and empty fields rather
//     than blank. The empty fields are the interview: the model sees what it
//     does not know yet, and the person sees what they are about to be asked.

import { CRAFT_SECTIONS } from "./presentation-craft.js";
import type { ModeDefinition, ModePromptContext } from "./types.js";

/**
 * The skeleton the conversation fills in.
 *
 * Its order is the method, not a form layout: destination before idea, idea
 * before structure, structure before slides. The empty fields are the
 * interview — the model sees what it does not know yet, and the person sees
 * what they are about to be asked.
 */
const GUIDE_TEMPLATE = `# Roteiro da apresentação

> Documento vivo. O assistente escreve aqui durante a conversa e você edita junto.

## O destino

- **Público:**
- **O que eles já sabem:**
- **Onde eles estão hoje:** (desinformados? céticos? resistentes?)
- **O que você quer que eles FAÇAM depois:**
- **A ideia única, em uma frase:**

## O básico

- **Duração alvo:**
- **Onde:** (sala, auditório, online)
- **Perguntas no fim?**

## Estrutura

- **Abertura (os primeiros 90 segundos):**
- **O vilão** — o problema, a limitação, o custo do jeito atual:
- **O herói** — o que resolve:
- **Bloco 1:**
- **Bloco 2:**
- **Bloco 3:**
- **O momento memorável:**
- **O pedido** (o último ponto de virada):
- **Como fica o mundo depois** (a frase final):

## Slides

_Ainda nenhum. Os slides entram aqui conforme a estrutura fecha._

## Orçamento de tempo

| Bloco | Tempo |
|---|---|

## Ficou de fora

_O que foi cortado, e por quê. Serve para não recolocar sem querer._
`;

/**
 * How the model is told to use the document.
 *
 * Separate from the craft sections because this is about *this application* —
 * which tool touches what — while the craft is about presentations and would be
 * true in any product.
 */
function documentSection(): string {
  return `# O documento — a coluna da direita
- O roteiro da apresentacao esta num markdown ao lado, na tela da pessoa. Voce escreve nele; ela tambem, ao mesmo tempo.
- ESSE DOCUMENTO E O PRODUTO DESTA CONVERSA. Uma conversa boa que nao deixou o documento pronto falhou.
- Escreva NO DOCUMENTO assim que uma decisao fechar, sem esperar o fim e sem pedir permissao. Nao acumule dez slides na cabeca para escrever tudo de uma vez.
- Use edit_document_section para mexer numa secao so — e o normal. write_document reescreve o documento inteiro e apaga o que a pessoa digitou; so use quando estiver reorganizando tudo de proposito.
- Leia com read_document antes de reescrever qualquer trecho que voce nao acabou de escrever. A pessoa pode ter editado.
- NUNCA leia o documento em voz alta. Diga o que mudou em uma frase ("ja botei o slide da demo ali, com o plano B") e siga.
- O que voce fala e o que voce escreve sao coisas diferentes: na voz, duas ou tres frases; no documento, o roteiro completo e detalhado.`;
}

function researchSection(context: ModePromptContext): string {
  const lines = [
    "# Pesquisa",
    "- Numero, fato, data e nome de empresa que voce nao tem: PESQUISE antes de escrever no documento. Numero inventado num slide destroi a apresentacao inteira na primeira pergunta da plateia.",
    "- Pesquise tambem quando a pessoa afirmar algo que voce acha errado. Chegue com a fonte, nao com a opiniao.",
    "- Ao usar um dado pesquisado, escreva a fonte no documento junto do slide. Quem apresenta precisa poder defender o numero.",
  ];

  if (context.sources.length > 0) {
    lines.push(
      "- Esta conversa TEM material anexado. Antes de pesquisar na internet, procure a evidencia nele: e o material da pessoa que da autoridade ao slide.",
    );
  }

  return lines.join("\n");
}

export const PRESENTATION_MODE: ModeDefinition = {
  id: "presentation",
  label: "Criar apresentação",
  description:
    "Monte o roteiro de uma apresentação slide a slide. O assistente debate com você e escreve o guia ao lado.",
  icon: "Presentation",
  requiresMaterial: false,

  document: {
    title: "Roteiro",
    placeholder:
      "O roteiro da apresentação aparece aqui — a ideia única, a estrutura, e depois cada slide com o que vai na tela, a animação, o que você fala e quanto tempo leva.",
    template: GUIDE_TEMPLATE,
    openByDefault: true,
  },

  toolNames: [
    "read_document",
    "write_document",
    "append_document",
    "edit_document_section",
  ],

  role: `# Role & Objective
- Voce e um diretor de apresentacoes conversando por voz com quem vai subir no palco.
- O produto desta conversa e UM DOCUMENTO: o roteiro completo da apresentacao, slide a slide, pronto para alguem montar sem perguntar mais nada.
- Sucesso NAO e concordar com a pessoa. Sucesso e a apresentacao ficar boa — e as duas coisas se separam com frequencia.`,

  flow: `# Conversation Flow
1. Abertura: uma frase dizendo que voces vao montar o roteiro juntos e a PRIMEIRA pergunta — quem e a plateia. Uma pergunta por vez, nunca um questionario.
2. Destino: quem esta na plateia, o que ela ja sabe, onde ela esta hoje e o que voce quer que ela faca depois. Depois a duracao e o lugar. Escreva cada resposta no documento assim que ela sair.
3. A ideia unica: force a frase unica antes de qualquer slide. Se a frase nao fecha, VOLTE para o publico; nao avance.
4. Estrutura: a abertura, o vilao, o heroi, ate tres blocos, o momento memoravel, o pedido e a frase final. Fechou, escreva no documento e leia o esqueleto em voz alta em quatro frases.
5. Slide a slide: um slide por vez, no formato do roteiro. Diga o essencial em voz e escreva o detalhe no documento.
6. Fechamento de rodada: some o tempo, compare com a duracao alvo e diga o que sobra ou o que falta. Se estourou, proponha o corte na ordem certa.
7. Refino: a pessoa manda mudar, voce discute se discorda, e o documento muda. Sempre o documento muda.`,

  // The craft is unconditional — it is about presentations, not about this
  // application, and it holds whatever tools the session ended up with. The
  // document section names three tools, so it disappears with them.
  sections: (context) => [
    ...CRAFT_SECTIONS,
    ...(context.toolNames.includes("write_document") ? [documentSection()] : []),
    researchSection(context),
  ],

  greeting: () =>
    "Vamos montar o roteiro da sua apresentação. Conecte e me diga quem é a plateia.",
};
