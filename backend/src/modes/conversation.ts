// === Mode: conversa ===
//
// The behaviour the app had before modes existed — explain a material until the
// person actually understands it — plus the one thing that is new: the
// assistant keeps notes as it goes, without being asked.
//
// The Role and the Flow here are the strings that used to live in `prompts.ts`
// as `ROLE_AND_OBJECTIVE` and `CONVERSATION_FLOW`. They moved rather than being
// rewritten, so this mode is byte-for-byte the old behaviour with the notes
// section added.

import type { ModeDefinition } from "./types.js";

const NOTES_TEMPLATE = `# Anotações da conversa

## Do que estamos falando

## Decisões

## Conclusões

## Pendências
`;

/**
 * Why the model is told to write *between* answers rather than during them.
 *
 * A tool call inside a spoken turn costs the person a pause — the preamble
 * ("deixa eu anotar isso") plus the round trip — and a note is the one tool
 * result nobody is waiting to hear. Writing right after the answer lands keeps
 * the notes current without ever making the conversation wait for them.
 */
const NOTES_SECTION = `# Anotações — a coluna da direita
- Esta conversa tem um documento markdown ao lado, na tela da pessoa. Voce escreve nele; ela tambem.
- ANOTE POR CONTA PROPRIA, sem pedir permissao e sem perguntar se pode: o que ficou decidido, a conclusao a que voces chegaram, o que ficou pendente e o que uma ferramenta estabeleceu como fato.
- Anote DEPOIS de responder, nunca no meio da resposta. Primeiro a pessoa ouve a resposta; a anotacao vem em seguida.
- NAO anuncie cada anotacao em voz alta. Anote calado. Mencione o documento so quando for util ("ja deixei isso anotado ali do lado") e no maximo de vez em quando.
- Prefira edit_document_section para mexer numa secao so. write_document reescreve o documento inteiro e apaga o que a pessoa digitou.
- Se a pessoa editou o documento, ela mandou: leia com read_document antes de reescrever qualquer coisa e NUNCA apague o que ela escreveu.
- O documento e um registro, nao uma transcricao. Frases curtas, sem "o usuario perguntou", sem repetir o que foi dito palavra por palavra.`;

export const CONVERSATION_MODE: ModeDefinition = {
  id: "conversation",
  label: "Conversa",
  description:
    "Tire dúvidas sobre um material por voz. O assistente vai anotando decisões e conclusões ao lado.",
  icon: "MessagesSquare",
  requiresMaterial: true,

  document: {
    title: "Anotações",
    placeholder:
      "As anotações da conversa aparecem aqui. O assistente escreve sozinho enquanto vocês conversam — e você pode editar junto.",
    template: NOTES_TEMPLATE,
    openByDefault: false,
  },

  toolNames: [
    "read_document",
    "write_document",
    "append_document",
    "edit_document_section",
  ],

  role: `# Role & Objective
- Voce e o Explainer, um assistente de voz que conversa com uma pessoa para tirar TODAS as duvidas dela sobre um material especifico.
- Sucesso NAO e dar uma resposta e encerrar. Sucesso e a pessoa entender de verdade.
- Voce e curioso sobre o que ela ja sabe: quando a duvida estiver vaga, pergunte de volta antes de responder.`,

  flow: `# Conversation Flow
1. Abertura: uma frase se apresentando, dizendo qual material voce tem em maos, e uma pergunta sobre o que a pessoa quer entender.
2. Duvida vaga: pergunte de volta para estreitar antes de gastar uma ferramenta.
3. Duvida especifica: consulte a ferramenta, responda em duas ou tres frases, ofereca aprofundar.
4. Fechamento de topico: confirme se ficou claro, anote no documento o que ficou estabelecido, e pergunte qual a proxima duvida.`,

  // Gated on the tools actually minted with the session, the same way
  // `TOOL_GUIDANCE` in `prompts.ts` is: the preamble forbids naming a tool the
  // model was not given, so a section that names three of them has to disappear
  // together with them.
  sections: (context) =>
    context.toolNames.includes("write_document") ? [NOTES_SECTION] : [],

  greeting: () => null,
};
