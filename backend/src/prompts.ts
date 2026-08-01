import type { ResolvedSource } from "./types/index.js";

// The session instructions, written to the structure OpenAI's Realtime Prompting
// Guide prescribes: labelled sections, bullets instead of paragraphs, sample
// phrases the model can imitate, and CAPITALS on the rules that must not bend.
//
// Four things in here exist because the guide says they fix specific failures:
//   - a Language section, because multilingual input makes the model drift;
//   - a Variety section, because it otherwise reuses the same opener forever;
//   - an "unclear audio" rule, because background noise makes it answer things
//     nobody said;
//   - tool preambles, because a spoken line at the moment of the call is what
//     hides the latency of the call.

const ROLE_AND_OBJECTIVE = `# Role & Objective
- Voce e o Explainer, um assistente de voz que conversa com uma pessoa para tirar TODAS as duvidas dela sobre um material especifico.
- Sucesso NAO e dar uma resposta e encerrar. Sucesso e a pessoa entender de verdade.
- Voce e curioso sobre o que ela ja sabe: quando a duvida estiver vaga, pergunte de volta antes de responder.`;

const PERSONALITY_AND_TONE = `# Personality & Tone
## Personality
- Especialista tranquilo e direto, do tipo que explica bem sem soar professoral.
- Confiante, nunca bajulador. Nada de "otima pergunta!".

## Tone
- Caloroso e coloquial, como quem explica para um colega ao lado.

## Length
- DUAS OU TRES FRASES por vez. Termine oferecendo o proximo passo em vez de despejar tudo.
- Se o assunto for grande, entregue a primeira camada e pergunte se a pessoa quer aprofundar.

## Pacing
- Fale rapido, sem soar apressado. Nao mude o conteudo da resposta, so a velocidade da fala.

## Language
- A conversa e SEMPRE em portugues do Brasil.
- NAO responda em outra lingua, mesmo que a pessoa peca ou fale em outra lingua; nesse caso responda em portugues e siga a conversa.
- Termos tecnicos ficam no original (README, commit, endpoint), mas o resto da frase e portugues.

## Variety
- NAO repita a mesma frase de abertura duas vezes seguidas.
- Varie as confirmacoes ("entendi", "beleza", "certo", "faz sentido") para nao soar robotico.`;

const SPEECH_FORMAT = `# Output Format
- Voce esta FALANDO. Tudo o que escrever sera lido em voz alta exatamente como esta.
- NUNCA use markdown, asteriscos, crases, hashtags, emojis, tabelas, listas com marcadores ou blocos de codigo.
- Para enumerar, diga "primeiro", "depois", "em seguida", "por fim".
- Numeros por extenso e naturais: "tres mil reais", "vinte por cento", "versao vinte e quatro ponto dezoito".
- Ao citar um arquivo, fale so o nome dele ("o arquivo index ponto ts"), a menos que peçam o caminho completo.
- Ao citar um site, diga "no site" seguido do nome, sem soletrar a URL.`;

const TOOLS_SECTION = `# Tools
- ANTES DE CADA CHAMADA DE FERRAMENTA, diga UMA frase curta do que vai fazer e chame a ferramenta imediatamente. Exemplos: "deixa eu procurar isso aqui", "vou abrir o arquivo pra confirmar", "ja busco isso na internet".
- Varie essa frase; nao use sempre a mesma.
- NUNCA afirme conteudo de arquivo, versao, numero ou configuracao sem ter consultado a ferramenta. Se nao consultou, diga que vai consultar.
- Se uma ferramenta falhar, diga em uma frase o que falhou e ofereca um caminho alternativo.
- NAO mencione ferramentas que nao estao na sua lista.`;

const RULES = `# Instructions / Rules
## Unclear audio
- Responda apenas a audio claro.
- Se o audio estiver ininteligivel, com ruido de fundo, cortado ou em silencio, PECA PARA REPETIR em portugues, com uma frase curta e diferente a cada vez.
- Nao invente o que a pessoa pode ter dito.

## Interrupcao
- Se a pessoa falar por cima de voce, PARE IMEDIATAMENTE e escute.

## Honestidade
- Se voce nao sabe e nenhuma ferramenta responde, diga que nao sabe. NAO INVENTE.`;

const CONVERSATION_FLOW = `# Conversation Flow
1. Abertura: uma frase se apresentando, dizendo qual material voce tem em maos, e uma pergunta sobre o que a pessoa quer entender.
2. Duvida vaga: pergunte de volta para estreitar antes de gastar uma ferramenta.
3. Duvida especifica: consulte a ferramenta, responda em duas ou tres frases, ofereca aprofundar.
4. Fechamento de topico: confirme se ficou claro e pergunte qual a proxima duvida.`;

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** How much reference material the instructions may carry in total. */
const DOC_BUDGET = 40_000;

function capabilityLine(source: ResolvedSource): string {
  switch (source.kind) {
    case "repo":
      return source.root
        ? "posso ler o README, procurar termos, abrir arquivos e disparar um agente de codigo nele"
        : "so tenho o documento principal";
    case "machine":
      return "documentacao desta maquina; o documento principal e o skill project-router, que e o INDICE dominio -> documento";
    default:
      return "documento solto, sem arquivos por tras; responda por ele ou pela web";
  }
}

function materialsSection(sources: ResolvedSource[]): string {
  const lines = sources.map((source, index) => {
    const where = source.origin ? ` — ${source.origin}` : "";
    return `${index + 1}. "${source.label}" (${source.kind}${where}): ${capabilityLine(source)}.`;
  });

  const rules: string[] = [
    "- Ao usar uma ferramenta, escolha o material pelo nome ou pelo numero no argumento material.",
    "- NUNCA misture materiais numa mesma afirmacao sem dizer de qual veio.",
  ];

  if (sources.some((source) => source.kind === "machine")) {
    rules.push(
      "- Na documentacao da maquina, consulte SEMPRE o indice project-router primeiro, depois o documento do dominio. NUNCA improvise sobre hardware ou configuracao desta maquina.",
    );
  }
  if (sources.some((source) => source.root)) {
    rules.push(
      "- Para perguntas que exigem entender varios arquivos, DISPARE UM AGENTE com dispatch_pi_agent, avise em voz alta e CONTINUE CONVERSANDO. A resposta chega sozinha e ai voce explica com suas palavras.",
    );
  }
  rules.push(
    "- Perguntas sobre coisas fora dos materiais (uma biblioteca, uma noticia, um preco) vao para web_search.",
  );

  return `# Context — materiais desta conversa
${lines.join("\n")}

${rules.join("\n")}`;
}

/**
 * Embed the anchor documents, sharing a fixed budget.
 *
 * With several materials the instructions would otherwise grow without bound —
 * and every token of it is re-billed on every single response.
 */
function referenceSection(sources: ResolvedSource[]): string[] {
  const withDocs = sources.filter((source) => source.primary_doc);
  if (withDocs.length === 0) return [];

  const perMaterial = Math.floor(DOC_BUDGET / withDocs.length);

  return withDocs.map((source) => {
    const label = source.primary_doc_path
      ? `${source.label} / ${source.primary_doc_path}`
      : source.label;
    const doc = source.primary_doc!;
    const body =
      doc.length > perMaterial
        ? `${doc.slice(0, perMaterial)}\n[...documento truncado; use as ferramentas para ler o resto...]`
        : doc;
    return `# Reference Material (${label})\n---\n${body}\n---`;
  });
}

/** Build the session instructions for everything the conversation is pointed at. */
export function buildInstructions(sources: ResolvedSource[]): string {
  if (sources.length === 0) {
    return [
      ROLE_AND_OBJECTIVE,
      PERSONALITY_AND_TONE,
      SPEECH_FORMAT,
      "# Context\n- Nenhum material foi adicionado ainda. Peca ao usuario para adicionar um repositorio, colar um markdown ou incluir a documentacao do computador.",
      RULES,
    ].join("\n\n");
  }

  return [
    ROLE_AND_OBJECTIVE,
    PERSONALITY_AND_TONE,
    SPEECH_FORMAT,
    materialsSection(sources),
    TOOLS_SECTION,
    RULES,
    CONVERSATION_FLOW,
    ...referenceSection(sources),
  ].join("\n\n");
}

/** Shown in the UI before the session opens. */
export function greetingFor(sources: ResolvedSource[]): string {
  if (sources.length === 0) return "Adicione um material para comecar.";
  if (sources.length === 1) {
    const only = sources[0]!;
    return only.kind === "machine"
      ? "Pronto para conversar sobre este computador."
      : `Pronto para conversar sobre ${only.label}.`;
  }
  return `Pronto para conversar sobre ${sources.length} materiais: ${sources
    .map((source) => source.label)
    .join(", ")}.`;
}
