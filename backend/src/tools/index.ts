import { MERMAID_KINDS } from "../services/mermaid.js";
import { MAX_THINKERS } from "../types/deep-tools.js";
import { getMode } from "../modes/registry.js";
import type { ModeDefinition } from "../modes/types.js";
import type { ResolvedSource, ToolName } from "../types/index.js";

/**
 * A tool as the Realtime API wants it.
 *
 * Note the flat shape: `type` / `name` / `description` / `parameters` all sit at
 * the top level. This is *not* the Chat Completions shape, where everything but
 * `type` is nested under `function`. Sending the nested one here silently gives
 * the model zero tools.
 */
export interface RealtimeTool {
  type: "function";
  name: ToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * A conversation can hold several materials at once, so every tool that touches
 * one takes this: the name, the number or the id of the material to use. Left
 * out, it means the first one.
 */
const MATERIAL_PARAM = {
  type: "string",
  description:
    "Qual material usar — o nome, o numero da lista ou o identificador. " +
    "Omita para usar o primeiro. Chame list_materials se estiver em duvida.",
};

const LIST_MATERIALS: RealtimeTool = {
  type: "function",
  name: "list_materials",
  description:
    "Lista os materiais desta conversa (repositorios, documentos, a documentacao " +
    "da maquina) com nome, tipo e o que da para fazer com cada um. Use quando o " +
    "usuario falar de mais de um material ou quando nao souber onde procurar.",
  parameters: { type: "object", properties: {} },
};

const WEB_SEARCH: RealtimeTool = {
  type: "function",
  name: "web_search",
  description:
    "Pesquisa na internet e devolve NA HORA o aviso de que a busca comecou; o " +
    "resultado chega sozinho depois, no fluxo da conversa, com as fontes. Use " +
    "para fatos atuais, noticias, documentacao de terceiros ou qualquer coisa " +
    "que nao esteja nos materiais. Ao disparar, avise o usuario em voz alta que " +
    "a busca comecou e CONTINUE A CONVERSA — nunca fique em silencio esperando. " +
    "So pode haver UMA busca por vez: disparar outra com uma em andamento e " +
    "recusado — espere terminar ou consulte o estado com check_web_search.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "O que pesquisar, em uma frase (maximo 400 caracteres).",
      },
    },
    required: ["query"],
  },
};

const CHECK_WEB_SEARCH: RealtimeTool = {
  type: "function",
  name: "check_web_search",
  description:
    "Consulta o estado de uma busca web disparada antes. Use apenas se o usuario " +
    "perguntar; normalmente o resultado chega sozinho quando fica pronto.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Identificador devolvido por web_search." },
    },
    required: ["job_id"],
  },
};

const READ_SOURCE_DOC: RealtimeTool = {
  type: "function",
  name: "read_source_doc",
  description:
    "Le o documento principal de um material (o README do repositorio, o skill de " +
    "roteamento da maquina, ou o markdown colado).",
  parameters: {
    type: "object",
    properties: {
      material: MATERIAL_PARAM,
      path: {
        type: "string",
        description:
          "Opcional: caminho relativo de outro documento dentro do material, " +
          "por exemplo docs/setup.md.",
      },
    },
  },
};

const SEARCH_SOURCE: RealtimeTool = {
  type: "function",
  name: "search_source",
  description:
    "Procura um termo ou expressao regular nos arquivos de um material e devolve " +
    "as linhas que casaram, com caminho e numero de linha. Use antes de responder " +
    "qualquer pergunta especifica sobre o conteudo.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Termo ou regex a procurar." },
      material: MATERIAL_PARAM,
      path: {
        type: "string",
        description: "Opcional: subdiretorio onde restringir a busca.",
      },
    },
    required: ["query"],
  },
};

const READ_SOURCE_FILE: RealtimeTool = {
  type: "function",
  name: "read_source_file",
  description:
    "Le um arquivo especifico de um material pelo caminho relativo. Use depois de " +
    "search_source ou list_source_files para confirmar detalhes.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Caminho relativo do arquivo, por exemplo src/index.ts.",
      },
      material: MATERIAL_PARAM,
    },
    required: ["path"],
  },
};

const LIST_SOURCE_FILES: RealtimeTool = {
  type: "function",
  name: "list_source_files",
  description:
    "Lista arquivos e pastas de um material. Use para se orientar antes de ler.",
  parameters: {
    type: "object",
    properties: {
      material: MATERIAL_PARAM,
      path: {
        type: "string",
        description: "Opcional: subdiretorio a listar. Vazio lista a raiz.",
      },
    },
  },
};

const DISPATCH_PI_AGENT: RealtimeTool = {
  type: "function",
  name: "dispatch_pi_agent",
  description:
    "Dispara um agente de codigo pi para investigar um material a fundo e " +
    "responder uma pergunta dificil. Retorna na hora com o identificador do " +
    "trabalho; a resposta chega depois. Use quando a pergunta exigir varios " +
    "arquivos ou entender como o codigo funciona de verdade, e avise o usuario " +
    "em voz alta que voce disparou o agente e que vai continuar conversando " +
    "enquanto ele trabalha.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "A pergunta que o agente deve responder sobre o material.",
      },
      material: MATERIAL_PARAM,
      context: {
        type: "string",
        description:
          "Opcional: nuances que NAO estao na conversa. O servidor anexa " +
          "automaticamente os ultimos momentos da conversa e os materiais; use " +
          "este campo so para o que voce julgar que nao aparece la.",
      },
    },
    required: ["question"],
  },
};

const CHECK_PI_AGENT: RealtimeTool = {
  type: "function",
  name: "check_pi_agent",
  description:
    "Consulta o estado de um agente pi disparado antes. Use apenas se o usuario " +
    "perguntar; normalmente a resposta chega sozinha quando fica pronta.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Identificador devolvido por dispatch_pi_agent." },
    },
    required: ["job_id"],
  },
};

const DEEP_THINK: RealtimeTool = {
  type: "function",
  name: "deep_think",
  description:
    "Dispara uma rodada de pensamento profundo: varios pensadores atacam o mesmo " +
    "cenario por angulos diferentes, pesquisam na internet e no fim tudo vira uma " +
    "conclusao unica. Retorna na hora com o aviso de que disparou; a conclusao " +
    "chega depois, sozinha, sem voce precisar perguntar. Use em decisoes dificeis, " +
    "trade-offs, riscos e planos com muitas variaveis. Avise o usuario em voz alta " +
    "que voce disparou os pensadores e continue a conversa enquanto eles trabalham.",
  parameters: {
    type: "object",
    properties: {
      scenario: {
        type: "string",
        description:
          "O cenario, a decisao ou o problema sobre o qual pensar, escrito por extenso.",
      },
      reflection: {
        type: "string",
        description:
          "Opcional: o que voce ja concluiu ou suspeita, para os pensadores partirem dai.",
      },
      thinker_count: {
        type: "integer",
        minimum: 1,
        // Ceiling and prose both come from MAX_THINKERS, the way `kind` below
        // comes from MERMAID_KINDS. `deliberation-tools.ts` clamps against the
        // same constant, so a literal here would eventually promise the model a
        // number the clamp silently takes away.
        maximum: MAX_THINKERS,
        description:
          `Opcional: quantos pensadores usar, de 1 a ${MAX_THINKERS}. Omita para ` +
          "deixar a ferramenta escolher pelo tamanho do problema.",
      },
    },
    required: ["scenario"],
  },
};

const CHECK_DEEP_THINK: RealtimeTool = {
  type: "function",
  name: "check_deep_think",
  description:
    "Consulta o estado da rodada de pensamento profundo desta conversa. Use apenas " +
    "se o usuario perguntar; normalmente a conclusao chega sozinha quando fica pronta.",
  parameters: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description:
          "Opcional: o identificador de uma rodada especifica. Omita para pegar a " +
          "rodada desta conversa.",
      },
    },
  },
};

const GENERATE_DIAGRAM: RealtimeTool = {
  type: "function",
  name: "generate_diagram",
  description:
    "Desenha um diagrama na tela do usuario. Descreva o desenho em linguagem " +
    "natural — as caixas, as setas, as etapas, quem fala com quem — e a ferramenta " +
    "devolve o diagrama pronto para a tela; voce nao escreve o codigo do desenho, " +
    "ela escreve por voce. Use quando o usuario pedir para ver algo, ou quando uma " +
    "arquitetura, um fluxo ou uma sequencia ficar mais clara desenhada do que falada.",
  parameters: {
    type: "object",
    properties: {
      instructions: {
        type: "string",
        description:
          "O que o diagrama deve mostrar, em linguagem natural: as caixas, as " +
          "setas, as etapas e o que liga cada coisa a cada coisa.",
      },
      kind: {
        type: "string",
        // The closed list comes from mermaid.ts so the schema and the generator's
        // own prompt can never drift into disagreeing about what exists.
        enum: [...MERMAID_KINDS],
        description:
          "Opcional: o tipo de diagrama, se voce ja souber qual quer. Omita para " +
          "deixar a ferramenta escolher pela descricao.",
      },
      title: {
        type: "string",
        description: "Opcional: titulo para aparecer acima do diagrama.",
      },
    },
    required: ["instructions"],
  },
};

// ---------------------------------------------------------------------------
// The conversation's own document
// ---------------------------------------------------------------------------
//
// Four tools over one markdown file per conversation. They are handed out by
// the mode, not by the materials, and the descriptions carry the division of
// labour between them because getting it wrong is expensive in both directions:
// a model that reaches for `write_document` to change one line erases whatever
// the user typed, and a model that never reaches for `edit_document_section`
// pays for the whole document on every small change.

const READ_DOCUMENT: RealtimeTool = {
  type: "function",
  name: "read_document",
  description:
    "Le o documento desta conversa, inteiro ou uma secao dele. Use antes de " +
    "reescrever qualquer trecho que voce nao acabou de escrever — o usuario " +
    "edita o mesmo documento e pode ter mudado alguma coisa.",
  parameters: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description:
          "Opcional: o titulo exato de uma secao, sem os #. Omita para ler tudo.",
      },
    },
  },
};

const WRITE_DOCUMENT: RealtimeTool = {
  type: "function",
  name: "write_document",
  description:
    "SUBSTITUI o documento inteiro pelo conteudo enviado. Use apenas ao criar o " +
    "documento do zero ou ao reorganizar tudo de proposito; para mudar um " +
    "pedaco, use edit_document_section, que nao apaga o resto.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "O documento completo, em markdown.",
      },
    },
    required: ["content"],
  },
};

const APPEND_DOCUMENT: RealtimeTool = {
  type: "function",
  name: "append_document",
  description:
    "Acrescenta um trecho no fim do documento, sem tocar no que ja esta la. Use " +
    "para adicionar um item novo — mais um slide, mais uma decisao, mais uma " +
    "pendencia.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "O trecho a acrescentar, em markdown.",
      },
    },
    required: ["content"],
  },
};

const EDIT_DOCUMENT_SECTION: RealtimeTool = {
  type: "function",
  name: "edit_document_section",
  description:
    "Troca UMA secao do documento pelo conteudo novo, mantendo todo o resto " +
    "intacto. E a forma normal de mexer no documento. Se a secao nao existir, " +
    "ela e criada no fim.",
  parameters: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description:
          "O titulo exato da secao a trocar, sem os # (por exemplo: Slide 3 — a demo).",
      },
      content: {
        type: "string",
        description:
          "O conteudo novo da secao, JA INCLUINDO a linha de titulo com os # " +
          "no nivel certo.",
      },
    },
    required: ["section", "content"],
  },
};

const DOCUMENT_TOOLS: Record<string, RealtimeTool> = {
  read_document: READ_DOCUMENT,
  write_document: WRITE_DOCUMENT,
  append_document: APPEND_DOCUMENT,
  edit_document_section: EDIT_DOCUMENT_SECTION,
};

/**
 * The tools a mode adds on top of what the materials grant.
 *
 * Resolved from names so `modes/` never carries a schema of its own — there is
 * one registry of tool shapes, and the flat-schema trap has one place to be got
 * right. A name with no definition here is dropped rather than thrown on: the
 * cost of a typo should be one missing tool, not a session that will not mint.
 */
function modeTools(mode: ModeDefinition): RealtimeTool[] {
  return mode.toolNames
    .map((name) => DOCUMENT_TOOLS[name])
    .filter((tool): tool is RealtimeTool => tool !== undefined);
}

/**
 * The tools that need no material at all.
 *
 * Thinking and drawing do not read a repository, so they ride next to
 * `web_search` in every conversation — including one with nothing added yet.
 *
 * `deep_think` is behind the Brave key because a thinker's only tool *is* a
 * Brave search (`services/deep-think.ts` gives it `brave_search` and nothing
 * else) and with no key `services/brave.ts` throws before the request leaves the
 * process. That failure does not kill the round: `deep-think.ts` catches it,
 * records a web failure and hands the thinker back "A busca falhou (…). Siga
 * raciocinando sem a web", so the round runs to the end — planner, every
 * thinker, synthesiser — and bills all of it to deliver a conclusion assembled
 * without a single source, while the tool's own description promises the model
 * that the thinkers "pesquisam na internet". A round that silently degrades to
 * an opinion costs more than a tool the model never had. Offering the tool is
 * the promise, so the gate is here rather than in an error further down.
 *
 * `check_deep_think` shares the gate because nothing else can start a round:
 * `dispatchDeepThink` is called only from `runDeepThink`, and `runDeepThink`
 * only from this tool list. Published alone it is dead weight in a frozen list,
 * and its one possible answer — "nenhuma rodada […] dispare uma nova" — is read
 * out loud, telling the model to reach for a tool it was not given.
 *
 * The env is read on every call instead of captured at import: this list is
 * rebuilt at each session mint, and a key exported after the process came up
 * still counts. The `trim()` matches `services/brave.ts`, so a key set to the
 * empty string is absent in both places rather than in only one.
 */
function deliberationTools(): RealtimeTool[] {
  const tools: RealtimeTool[] = [];
  if (process.env.BRAVE_API_KEY?.trim()) tools.push(DEEP_THINK, CHECK_DEEP_THINK);
  tools.push(GENERATE_DIAGRAM);
  return tools;
}

/**
 * Applies the mode's alternative descriptions to a minted tool list.
 *
 * A tool description reaches the model verbatim in the Realtime session, so a
 * mode whose behaviour breaks what the shared text promises — research
 * dispatches a fan of parallel web searches, the shared `web_search` says one
 * at a time — has to mint its own text. The constants above are read by every
 * mode and are never mutated: a tool under an overriding mode is a clone with
 * the mode's description, and the shared text keeps telling the truth to the
 * modes that keep the rule.
 */
function withModeDescriptions(tools: RealtimeTool[], mode: ModeDefinition): RealtimeTool[] {
  const descriptions = mode.toolDescriptions;
  if (!descriptions) return tools;
  return tools.map((tool) => {
    const description = descriptions[tool.name];
    return description !== undefined ? { ...tool, description } : tool;
  });
}

/**
 * Which tools the model gets, decided by what is actually in the conversation.
 *
 * The rule from the original concept still holds per material — a repository
 * unlocks grep and the agents, a loose markdown document unlocks nothing but the
 * web — it is just a union now. A conversation holding one repo and one pasted
 * spec gets the repository toolkit, and the model is told which material each
 * tool can reach.
 */
export function toolsForSources(
  sources: ResolvedSource[],
  mode: ModeDefinition = getMode(undefined),
): RealtimeTool[] {
  // Appended last, and always in the mode's own declaration order: the session
  // config is cached upstream by content, so the same conversation has to
  // produce the same bytes on every reconnect.
  const fromMode = modeTools(mode);

  if (sources.length === 0) {
    return withModeDescriptions(
      [WEB_SEARCH, CHECK_WEB_SEARCH, ...deliberationTools(), ...fromMode],
      mode,
    );
  }

  const hasFiles = sources.some((source) => Boolean(source.root));
  const tools: RealtimeTool[] = [READ_SOURCE_DOC];

  if (hasFiles) {
    tools.push(
      SEARCH_SOURCE,
      READ_SOURCE_FILE,
      LIST_SOURCE_FILES,
      DISPATCH_PI_AGENT,
      CHECK_PI_AGENT,
    );
  }

  tools.push(WEB_SEARCH, CHECK_WEB_SEARCH, ...deliberationTools(), ...fromMode);

  // Naming a material only makes sense when there is more than one to name.
  if (sources.length > 1) tools.unshift(LIST_MATERIALS);

  return withModeDescriptions(tools, mode);
}

export const ALL_TOOLS: RealtimeTool[] = [
  LIST_MATERIALS,
  READ_SOURCE_DOC,
  SEARCH_SOURCE,
  READ_SOURCE_FILE,
  LIST_SOURCE_FILES,
  DISPATCH_PI_AGENT,
  CHECK_PI_AGENT,
  WEB_SEARCH,
  CHECK_WEB_SEARCH,
  DEEP_THINK,
  CHECK_DEEP_THINK,
  GENERATE_DIAGRAM,
  READ_DOCUMENT,
  WRITE_DOCUMENT,
  APPEND_DOCUMENT,
  EDIT_DOCUMENT_SECTION,
];
