import type { ResolvedSource } from "./types/index.js";
import type { MemoryResume } from "./types/deep-tools.js";

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

const TOOLS_PREAMBLE = `# Tools
- ANTES DE CADA CHAMADA DE FERRAMENTA, diga UMA frase curta do que vai fazer e chame a ferramenta imediatamente. Exemplos: "deixa eu procurar isso aqui", "vou abrir o arquivo pra confirmar", "ja busco isso na internet".
- Varie essa frase; nao use sempre a mesma.
- NUNCA afirme conteudo de arquivo, versao, numero ou configuracao sem ter consultado a ferramenta. Se nao consultou, diga que vai consultar.
- Se uma ferramenta falhar, diga em uma frase o que falhou e ofereca um caminho alternativo.
- NAO mencione ferramentas que nao estao na sua lista.`;

/**
 * The paragraph each tool needs, keyed by the name the session was given.
 *
 * Only the tools whose *behaviour* is surprising are in here. The rest are
 * described well enough by their own `description` in `tools/index.ts`; these
 * three are not, because what they need from the model happens outside the call:
 * two of them answer immediately and conclude minutes later, and the third draws
 * on a screen the model cannot see.
 *
 * Keyed and filtered rather than written as one block, for two reasons:
 *
 *   - The tool list is decided per session and frozen into the client secret.
 *     `deep_think` and `check_deep_think` are behind `BRAVE_API_KEY` (see
 *     `deliberationTools` in `tools/index.ts`), so with no key the model is not
 *     given them — and teaching it to "avisar que colocou varios pensadores no
 *     assunto e CONTINUAR CONVERSANDO" then promises a conclusion that no round
 *     can ever produce, while the preamble above tells it not to mention tools
 *     it does not have. The instructions would contradict themselves.
 *   - Instructions are re-billed on every single response. A paragraph about a
 *     tool the session does not hold is paid for on every turn of the call.
 *
 * Iterated in declaration order, not in the caller's: the session config is
 * cached upstream by content, so the same tool set must always produce the same
 * bytes.
 */
const TOOL_GUIDANCE: Record<string, string> = {
  deep_think: `## deep_think — pensar fundo sem parar a conversa
- Use para pergunta que pede analise de verdade: comparar caminhos, decidir entre opcoes, achar o risco escondido. NAO use para consulta simples; para isso ja existem as outras ferramentas.
- Ela responde NA HORA dizendo que a rodada comecou. A conclusao chega SOZINHA, depois, e ai voce a explica com suas palavras.
- Ao chamar, avise em voz alta que colocou varios pensadores no assunto e CONTINUE CONVERSANDO. NUNCA fique em silencio esperando a conclusao.
- Quando a conclusao chegar, retome dizendo que a analise ficou pronta antes de explicar.`,

  check_deep_think: `## check_deep_think — so quando perguntarem
- Chame APENAS se a pessoa perguntar como esta a rodada ("e ai, ja pensou?", "como ta aquilo?").
- NAO fique consultando por conta propria: a conclusao chega sozinha e consultar de novo nao acelera nada.`,

  generate_diagram: `## generate_diagram — desenhar em vez de descrever
- Use quando a explicacao ficar mais clara desenhada: um fluxo, uma sequencia de passos, como as partes se ligam.
- O diagrama aparece NA TELA da pessoa. Fale a legenda com suas palavras e diga que esta na tela.
- NUNCA leia a sintaxe do diagrama em voz alta: nada de setas, colchetes, nomes de nos ou a palavra mermaid.`,
};

function toolsSection(toolNames: readonly string[]): string {
  const held = new Set(toolNames);
  const taught = Object.entries(TOOL_GUIDANCE)
    .filter(([name]) => held.has(name))
    .map(([, guidance]) => guidance);

  return [TOOLS_PREAMBLE, ...taught].join("\n\n");
}

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

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * What a resumed conversation may carry, in characters.
 *
 * Its own budget rather than a share of `DOC_BUDGET`, because the two compete
 * for the same scarce thing: the instructions are re-billed on *every* response,
 * so every character here is paid for again on every turn of the new session.
 * That is also the reason this section is built from `MemoryResume` and never
 * from `MemoryFile.events` — a transcript pasted in here would be the single
 * most expensive string in the app, and `buildResume` exists precisely to
 * compress it once instead.
 */
const RESUME_BUDGET = 6_000;
const RESUME_SUMMARY_BUDGET = 2_600;
const RESUME_REFLECTIONS_BUDGET = 2_000;
const RESUME_REFLECTION_CHARS = 400;
const RESUME_FINDINGS_BUDGET = 1_000;
const RESUME_FINDING_CHARS = 240;
const RESUME_MATERIALS_CHARS = 300;

/** The ellipsis counts against the limit: these are budgets, not suggestions. */
function clip(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Keep whole entries while the budget lasts, newest first.
 *
 * Read backwards and then restored to chronological order: what a resumed
 * conversation needs most is the last thing it concluded, and cutting from the
 * front would drop exactly that.
 */
function fitEntries(entries: string[], perEntry: number, total: number): string[] {
  const kept: string[] = [];
  let used = 0;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const text = clip(entries[i]!, perEntry);
    if (!text) continue;
    if (used + text.length > total) break;
    kept.push(text);
    used += text.length;
  }

  return kept.reverse();
}

function memorySection(resume: MemoryResume): string {
  const header = [
    "- Esta conversa JA ACONTECEU antes e voce esta RETOMANDO ela agora.",
    "- Isto substitui o passo 1 do Conversation Flow: NAO se apresente de novo, NAO recomece do zero. Retome de onde parou.",
    "- Trate o que vem abaixo como sua propria memoria: fale como quem lembra, nao como quem acabou de ler um relatorio.",
    "- Se algum ponto estiver vago e for importante agora, confirme com a pessoa antes de tratar como certo.",
    `- Eventos registrados ate aqui: ${resume.event_count}.`,
  ];

  if (resume.materials.length > 0) {
    header.push(
      `- Materiais que a conversa usava: ${clip(resume.materials.join(", "), RESUME_MATERIALS_CHARS)}.`,
    );
  }

  const parts = [
    `# Memoria desta conversa\n${header.join("\n")}`,
    `## Resumo do que ja foi conversado\n${clip(resume.summary, RESUME_SUMMARY_BUDGET)}`,
  ];

  const reflections = fitEntries(
    resume.reflections,
    RESUME_REFLECTION_CHARS,
    RESUME_REFLECTIONS_BUDGET,
  );
  if (reflections.length > 0) {
    parts.push(
      `## Conclusoes que a conversa ja tirou\n${reflections.map((text) => `- ${text}`).join("\n")}`,
    );
  }

  const findings = fitEntries(
    resume.tool_findings,
    RESUME_FINDING_CHARS,
    RESUME_FINDINGS_BUDGET,
  );
  if (findings.length > 0) {
    parts.push(
      `## O que as ferramentas ja estabeleceram\n${findings.map((text) => `- ${text}`).join("\n")}`,
    );
  }

  // The parts are each bounded above; this is the ceiling on their sum, so the
  // section cannot grow by adding one more part later.
  return clip(parts.join("\n\n"), RESUME_BUDGET);
}

/**
 * Build the session instructions for everything the conversation is pointed at.
 *
 * `resume` is the compressed form of the conversation file — never the file
 * itself. See `memorySection` for why the raw events cannot come in here.
 *
 * `toolNames` is the list the same session is being minted with — the caller
 * already computed it for the `tools` field, and passing it here is what keeps
 * the Tools section describing tools the model was actually given. Omitted, no
 * tool is described: an unknown list is not a licence to promise behaviour, and
 * the preamble forbids naming a tool that is not in the model's own list.
 */
export function buildInstructions(
  sources: ResolvedSource[],
  resume?: MemoryResume | null,
  toolNames: readonly string[] = [],
): string {
  const memory = resume ? [memorySection(resume)] : [];

  if (sources.length === 0) {
    return [
      ROLE_AND_OBJECTIVE,
      PERSONALITY_AND_TONE,
      SPEECH_FORMAT,
      "# Context\n- Nenhum material foi adicionado ainda. Peca ao usuario para adicionar um repositorio, colar um markdown ou incluir a documentacao do computador.",
      RULES,
      ...memory,
    ].join("\n\n");
  }

  return [
    ROLE_AND_OBJECTIVE,
    PERSONALITY_AND_TONE,
    SPEECH_FORMAT,
    materialsSection(sources),
    toolsSection(toolNames),
    RULES,
    CONVERSATION_FLOW,
    // After the flow on purpose: the memory section cancels its step 1, and the
    // later instruction is the one that wins.
    ...memory,
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
