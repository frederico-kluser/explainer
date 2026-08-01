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
    "Pesquisa na internet e devolve uma resposta curta com fontes. Use para fatos " +
    "atuais, noticias, documentacao de terceiros ou qualquer coisa que nao esteja " +
    "nos materiais da conversa.",
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
        description: "Opcional: o que ja se sabe, para o agente nao repetir trabalho.",
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

/**
 * Which tools the model gets, decided by what is actually in the conversation.
 *
 * The rule from the original concept still holds per material — a repository
 * unlocks grep and the agents, a loose markdown document unlocks nothing but the
 * web — it is just a union now. A conversation holding one repo and one pasted
 * spec gets the repository toolkit, and the model is told which material each
 * tool can reach.
 */
export function toolsForSources(sources: ResolvedSource[]): RealtimeTool[] {
  if (sources.length === 0) return [WEB_SEARCH];

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

  tools.push(WEB_SEARCH);

  // Naming a material only makes sense when there is more than one to name.
  if (sources.length > 1) tools.unshift(LIST_MATERIALS);

  return tools;
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
];
