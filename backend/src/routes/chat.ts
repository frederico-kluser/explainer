import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { deepseekChat, deepseekReasoner, DeepSeekError } from "../services/deepseek.js";
import { executeTool } from "../services/tool-executor.js";
import { listSources } from "../services/source-store.js";
import { ALL_TOOLS } from "../tools/index.js";
import type { DeepSeekMessage, DeepSeekTool } from "../types/index.js";
import type { RealtimeTool } from "../tools/index.js";

const router = Router();

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

type IntentCategory = "conversation" | "task_without_reading" | "task_with_reading";

const CLASSIFICATION_PROMPT = `Classifique a mensagem do usuario em exatamente UMA destas categorias. Responda APENAS com o rotulo, sem explicacao, sem pontuacao, sem mais nada:

- conversation — bate-papo casual, cumprimentos, "oi", "como vai", perguntas sobre o assistente, conversa cotidiana. O usuario NAO esta pedindo para gerar codigo nem para investigar um projeto.
- task_without_reading — o usuario quer gerar codigo, escrever um texto, responder uma pergunta factual, fazer um calculo, traduzir algo, ou qualquer tarefa que NAO exija ler arquivos de um repositorio.
- task_with_reading — o usuario quer que voce investigue um repositorio, procure codigo, leia arquivos, entenda como algo funciona no projeto. Qualquer pergunta que so pode ser respondida lendo os materiais da conversa.`;

async function classifyIntent(
  message: string,
  conversationId?: string,
): Promise<IntentCategory> {
  const messages: DeepSeekMessage[] = [
    { role: "system", content: CLASSIFICATION_PROMPT },
    { role: "user", content: message },
  ];

  const result = await deepseekChat(messages, {
    max_tokens: 256,
    temperature: 0,
    conversationId,
  });

  // OpenAI-compatible wire contract permits null content.
  const rawContent = result.message.content;
  const label = (rawContent ?? "task_without_reading").trim().toLowerCase();

  if (label === "conversation") return "conversation";
  if (label === "task_without_reading") return "task_without_reading";
  if (label === "task_with_reading") return "task_with_reading";

  // Ambiguous labels fall back to direct generation rather than erroring —
  // a wrong direct answer is cheaper than a ReAct loop on a casual chat.
  console.warn(
    `[chat] Unexpected classification label: "${label}", falling back to task_without_reading`,
  );
  return "task_without_reading";
}

// ---------------------------------------------------------------------------
// Direct response (no tools needed)
// ---------------------------------------------------------------------------

async function handleDirectTask(message: string, conversationId?: string) {
  const messages: DeepSeekMessage[] = [{ role: "user", content: message }];

  const result = await deepseekChat(messages, { conversationId });

  return {
    mode: "task" as const,
    type: "direct" as const,
    answer: result.message.content,
  };
}

// ---------------------------------------------------------------------------
// ReAct loop (tools + reasoning)
// ---------------------------------------------------------------------------

const REACT_PROMPT = `Voce e um assistente de codigo que investiga repositorios. Use as ferramentas disponiveis para explorar os materiais da conversa e responder a pergunta do usuario.

Regras:
1. Use search_source para encontrar codigo relevante antes de responder qualquer pergunta sobre o projeto.
2. Use read_source_file para confirmar detalhes de arquivos especificos.
3. Use list_source_files para se orientar quando nao souber a estrutura do projeto.
4. Use dispatch_pi_agent para investigacoes complexas que exigem entender varios arquivos de uma vez.
5. NAO invente respostas — baseie-se apenas no que encontrar nos arquivos do projeto.
6. Responda em portugues brasileiro, de forma clara e direta.
7. Se nao encontrar a resposta, diga honestamente que nao encontrou.`;

// DeepSeek's API nests tool metadata under `function`, unlike the Realtime API.
function toDeepSeekTool(tool: RealtimeTool): DeepSeekTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };
}

const DEEPSEEK_TOOLS: DeepSeekTool[] = ALL_TOOLS.map(toDeepSeekTool);

const MAX_REACT_ITERATIONS = 10;

// -- SSE helpers -------------------------------------------------------------

function sendSSE(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function safeParseJSON(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Pi agent polling --------------------------------------------------------

async function pollPiAgent(
  jobId: string,
  conversationId: string,
  res: Response,
): Promise<string> {
  const deadline = Date.now() + 180_000; // 3 minutes

  while (Date.now() < deadline) {
    await sleep(2000);

    const result = await executeTool(
      "check_pi_agent",
      JSON.stringify({ job_id: jobId }),
      conversationId,
    );

    if (result.meta?.status === "done") {
      sendSSE(res, {
        type: "tool_result",
        tool: "dispatch_pi_agent",
        output: result.output.slice(0, 500),
      });
      return result.output;
    }

    if (result.meta?.status === "error" || result.meta?.status === "cancelled") {
      const errorMsg = result.output || "O agente terminou com erro.";
      sendSSE(res, {
        type: "tool_result",
        tool: "dispatch_pi_agent",
        output: errorMsg.slice(0, 500),
      });
      return errorMsg;
    }

    // Job not found — check_pi_agent returns no meta when the job id doesn't
    // exist. Treat as an error so we don't poll the full 3-minute deadline.
    if (!result.meta || result.meta.status === undefined) {
      const errorMsg = result.output || "Job do agente nao encontrado.";
      sendSSE(res, {
        type: "tool_result",
        tool: "dispatch_pi_agent",
        output: errorMsg.slice(0, 500),
      });
      return errorMsg;
    }

    // "running" — keep polling
  }

  const timeoutMsg = "O agente pi excedeu o tempo limite de 3 minutos.";
  sendSSE(res, {
    type: "tool_result",
    tool: "dispatch_pi_agent",
    output: timeoutMsg,
  });
  return timeoutMsg;
}

// -- ReAct loop --------------------------------------------------------------

async function runReActLoop(
  res: Response,
  userMessage: string,
  conversationId: string,
) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const systemContent = REACT_PROMPT;

  // Include materials context so the model knows what it can search.
  let materialCtx = "";
  try {
    const sources = await listSources(conversationId);
    if (sources.length > 0) {
      materialCtx =
        "\n\nMateriais disponiveis nesta conversa:\n" +
        sources.map((s, i) => `${i + 1}. ${s.label} (${s.kind})`).join("\n");
    }
  } catch {
    // The conversation might not exist yet; proceed without materials context.
  }

  const messages: DeepSeekMessage[] = [
    { role: "system", content: systemContent + materialCtx },
    { role: "user", content: userMessage },
  ];

  try {
    for (let iteration = 0; iteration < MAX_REACT_ITERATIONS; iteration++) {
      const result = await deepseekReasoner(messages, DEEPSEEK_TOOLS, {
        conversationId,
      });

      const choiceMessage = result.message;
      const toolCalls = choiceMessage.tool_calls;
      const content = choiceMessage.content;

      // Record the assistant turn in history.
      const assistantMsg: DeepSeekMessage = {
        role: "assistant",
        content: content || "",
      };
      if (toolCalls && toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      messages.push(assistantMsg);

      // -- Execute tool calls -------------------------------------------------

      if (toolCalls && toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments;

          sendSSE(res, {
            type: "tool_call",
            tool: toolName,
            args: safeParseJSON(toolArgs),
          });

          let toolOutput: string;

          if (toolName === "dispatch_pi_agent") {
            // Dispatch returns a job id immediately; block on polling so the
            // model gets the final answer in a single tool round-trip.
            const dispatchResult = await executeTool(
              toolName,
              toolArgs,
              conversationId,
            );

            sendSSE(res, {
              type: "tool_result",
              tool: toolName,
              output: dispatchResult.output.slice(0, 500),
            });

            const jobId = dispatchResult.meta?.job_id as string | undefined;
            if (jobId) {
              toolOutput = await pollPiAgent(jobId, conversationId, res);
            } else {
              toolOutput = dispatchResult.output;
            }
          } else {
            const toolResult = await executeTool(
              toolName,
              toolArgs,
              conversationId,
            );
            toolOutput = toolResult.output;

            sendSSE(res, {
              type: "tool_result",
              tool: toolName,
              output: toolOutput.slice(0, 500),
            });
          }

          messages.push({
            role: "tool",
            content: toolOutput,
            tool_call_id: toolCall.id,
          });
        }
        continue;
      }

      // -- No tool calls — the model produced a final answer ------------------

      if (content || result.finishReason === "stop") {
        sendSSE(res, { type: "answer", content: content || "" });
        break;
      }

      // Neither content nor tool calls — the model stalled.
      sendSSE(res, {
        type: "error",
        message:
          "O modelo nao produziu resposta nem chamadas de ferramenta. Tente reformular a pergunta.",
      });
      break;
    }

    // If the loop exhausted all iterations without producing a final answer
    // (the last turn produced tool_calls that were executed), make one more
    // reasoner call so the model can produce a conclusion from the accumulated
    // tool results.
    {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "tool") {
        const finalResult = await deepseekReasoner(messages, DEEPSEEK_TOOLS, {
          conversationId,
        });
        sendSSE(res, { type: "answer", content: finalResult.message.content || "" });
      }
    }
  } catch (err) {
    // In-band error reporting: headers are already sent, so write an SSE event
    // instead of calling res.status().json() which would throw ERR_HTTP_HEADERS_SENT.
    const message =
      err instanceof DeepSeekError
        ? `Erro na API DeepSeek: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Erro desconhecido no processamento.";

    sendSSE(res, { type: "error", message });
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response) => {
  try {
    const { message, conversationId } = req.body as {
      message?: string;
      conversationId?: string;
    };

    // Validate input.
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({
        error:
          "O campo 'message' e obrigatorio e deve ser uma string nao vazia.",
      });
      return;
    }

    // Step 1 — classify the intent.
    let intent: IntentCategory;
    try {
      intent = await classifyIntent(message.trim(), conversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[chat] Classification failed: ${msg}`);
      res.status(502).json({
        error:
          "Falha ao classificar a mensagem. Verifique a conexao com a API DeepSeek.",
      });
      return;
    }

    // Step 2 — route by intent.
    switch (intent) {
      case "conversation":
        res.json({ mode: "conversation" });
        break;

      case "task_without_reading": {
        try {
          const result = await handleDirectTask(message.trim(), conversationId);
          res.json(result);
        } catch (err) {
          const status =
            err instanceof DeepSeekError ? err.status : 500;
          const msg = err instanceof Error ? err.message : "Erro desconhecido";
          res
            .status(status >= 400 && status < 600 ? status : 500)
            .json({ error: `Erro ao processar a tarefa: ${msg}` });
        }
        break;
      }

      case "task_with_reading": {
        // Generate a stable id for conversations that don't have one yet so
        // source-store has something to key on.
        const convId = conversationId ?? `chat-${randomUUID()}`;
        await runReActLoop(res, message.trim(), convId);
        break;
      }

      default:
        res.status(500).json({ error: "Classificacao inesperada." });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro desconhecido";
    console.error(`[chat] Unhandled error: ${msg}`);
    if (!res.headersSent) {
      res.status(500).json({ error: `Erro interno: ${msg}` });
    }
  }
});

export default router;
