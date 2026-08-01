# Explainer — converse por voz sobre um repositório, um documento, ou esta máquina

Você aponta o Explainer para um material e conversa com ele. Sem latência de
turno: o áudio vai e volta por uma conexão WebRTC direta com um modelo realtime
da OpenAI, então ele começa a falar enquanto ainda está pensando, e você pode
interrompê-lo no meio de uma frase.

Uma conversa segura **vários materiais ao mesmo tempo** (até seis) — você adiciona
e remove quando quiser, e o modelo escolhe de qual deles tirar cada resposta.

| Material | Como você adiciona | O que o modelo ganha |
|---|---|---|
| **Repositório** | `github.com/dono/repo`, `dono/repo`, ou **navegando pelas pastas da máquina** | ler o README, procurar no código, abrir arquivos, **disparar agentes `pi`** e buscar na web |
| **Markdown** | cola o texto ou arrasta um `.md` | o documento inteiro no contexto, e busca na web |
| **Meu computador** | um clique | a documentação da máquina em `~/Projects/config`, cujo skill `project-router` é o índice domínio → documento |

Com mais de um material o modelo ganha `list_materials`, e toda ferramenta passa
a aceitar um argumento `material` — então dá para perguntar *"qual processador
tem essa máquina, e qual modelo de voz o projeto usa?"* e ele consulta os dois em
paralelo, dizendo de qual veio cada resposta.

O agente `pi` é a parte que muda o jogo em perguntas difíceis: o modelo dispara
um agente de código no repositório, avisa você em voz alta que mandou, **continua
conversando**, e narra o resultado quando ele chega — normalmente um minuto
depois, sem nunca ter travado a conversa.

## Quickstart

```bash
cp .env.example .env
# preencha OPENAI_API_KEY
npm run setup
npm run dev
```

Abra http://localhost:5173, escolha uma fonte, clique no microfone e fale.

`npm run dev` sobe backend (3001) e frontend (Vite, 5173) juntos via `dev.sh`.
Ctrl+C derruba os dois.

**Pré-requisitos:** Node.js 22+. Opcionais: `git` (para clonar repositórios do
GitHub), `rg` (busca mais rápida; cai para `grep` se faltar), `pi`
(`npm i -g @mariozechner/pi-coding-agent`, para os agentes de código),
`surf-research-skill` (fallback de busca na web).

## Variáveis de ambiente

| Variável | Descrição | Default | Obrigatória |
|---|---|---|---|
| `OPENAI_API_KEY` | Chave da OpenAI. Fica só no servidor | — | **Sim** |
| `OPENAI_REALTIME_MODEL` | Modelo de voz | `gpt-realtime-2.1` | Não |
| `OPENAI_REALTIME_VOICE` | Voz | `marin` | Não |
| `OPENAI_SEARCH_MODEL` | Modelo do `web_search` (Responses API) | `gpt-5.2` | Não |
| `OPENAI_TEXT_MODEL` | Modelo para títulos e resumos | `gpt-5.2-mini` | Não |
| `OPENAI_ADMIN_KEY` | Chave de administração, só para ler o gasto da OpenAI | — | Não |
| `EXPLAINER_MACHINE_DOCS` | Docs da máquina | `~/Projects/config` | Não |
| `EXPLAINER_REPO_ROOTS` | Diretórios extras permitidos como repo local | `~/Projects` + cache | Não |
| `PI_BIN` / `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING` / `PI_TIMEOUT_MS` | Configuração do agente `pi` | do `~/.pi/agent/settings.json` | Não |
| `PORT` | Porta do backend | `3001` | Não |

O backend lê `.env` de `backend/` ou da raiz do repositório.

## API

| Method | Path | Body | Descrição |
|---|---|---|---|
| `GET` | `/api/health` | — | Health check |
| `POST` | `/api/sources` | `{ conversation_id, source: { kind, ref?, markdown? } }` | Adiciona um material |
| `GET` | `/api/sources/:convId` | — | Os materiais da conversa |
| `DELETE` | `/api/sources/:convId/:materialId` | — | Remove um material |
| `GET` | `/api/browse?path=` | — | Navega as pastas permitidas, marcando repositórios git |
| `POST` | `/api/realtime/session` | `{ conversation_id }` | Cunha o client secret efêmero (10 min) |
| `POST` | `/api/realtime/tool` | `{ conversation_id, call_id, name, arguments }` | Executa uma function call do modelo |
| `GET` | `/api/agents/events?conversation_id=` | — | SSE com o progresso dos agentes `pi` |
| `GET` | `/api/agents/:jobId` | — | Estado de um job |
| `POST` | `/api/agents/:jobId/cancel` | — | Mata um agente em execução |
| `POST` | `/api/costs/realtime` | `{ conversation_id, usage, model }` | Registra e precifica o uso de uma resposta |
| `GET` | `/api/costs/:convId` | — | Quanto a conversa custou, por origem |
| `GET` | `/api/credits` | — | Saldo em OpenAI, OpenRouter e DeepSeek |
| `GET`/`PATCH` | `/api/conversations/:id/settings` | `{ voice?, speed? }` | Voz e velocidade da conversa |
| `GET`/`POST` | `/api/conversations` | — / `{ title }` | Lista / cria |
| `GET`/`PATCH`/`DELETE` | `/api/conversations/:id` | — | Uma conversa |
| `POST` | `/api/conversations/:id/messages` | `{ messages: [...] }` | Persiste turnos da transcrição |

## Arquitetura

```
Browser (React 19 + Vite 6 + Motion UI)
   │
   ├── RTCPeerConnection ──── áudio ────► OpenAI Realtime (gpt-realtime-2.1)
   │      └── DataChannel "oai-events" ── transcrições, function calls
   │
   └── HTTP ──► Backend (Node 22 + Express 5)
                  ├── POST /api/realtime/session  → client secret efêmero
                  ├── POST /api/realtime/tool     → executa a ferramenta
                  ├── /api/sources                → resolve repo | markdown | máquina
                  └── /api/agents/events (SSE)    → agentes pi em segundo plano
                          │
                          └── pi -p --mode json -t read,glob,grep,find,ls
```

Três decisões explicam o resto do código:

**O áudio não passa pelo backend.** O browser abre a própria conexão WebRTC. O
backend só cunha um token curto com o modelo, a voz, as instruções e a lista de
ferramentas já fixados do lado do servidor — um browser adulterado consegue
gastar aquela sessão e nada além disso.

**As ferramentas rodam no servidor.** O modelo emite `function_call` no data
channel, o browser repassa para `POST /api/realtime/tool`, e o resultado volta
como `function_call_output`. O sistema de arquivos, os subprocessos e as chaves
ficam onde sempre estiveram. A `response.create` só é disparada depois que
todos os outputs foram confirmados — mandar antes é o jeito clássico de perder
o turno com *"Conversation already has an active response"*.

**Ferramenta lenta não bloqueia conversa.** `dispatch_pi_agent` responde em
milissegundos com um id de job; o agente roda em background com allowlist
somente-leitura e timeout de 180 s; o resultado chega pelo SSE e é injetado na
conversa como um novo item, seguido de `response.create`. O modelo narra a
resposta que pediu um minuto antes.

**Custos.** Cada `response.done` carrega o consumo de tokens da resposta. O
browser reporta os números crus e o **servidor** aplica a tabela de preços
(`backend/src/services/pricing.ts`, conferida em 01/08/2026: áudio a trinta e dois
dólares por milhão na entrada e sessenta e quatro na saída, texto a quatro e
vinte e quatro, cache a quarenta centavos). Busca na web e agentes `pi` entram no
mesmo livro-caixa. O painel na barra lateral mostra o total por origem e o saldo
de cada provedor — a OpenAI só responde saldo para uma chave de administração,
então sem `OPENAI_ADMIN_KEY` ela aparece explicando isso em vez de mentir um
número.

**Materiais e limites.** A lista fica na metadata da conversa, então sobrevive a
restart e a reload. Um repositório local precisa estar sob `~/Projects` (ou sob
`EXPLAINER_REPO_ROOTS`) — o mesmo limite vale para o navegador de pastas, que é
um seletor, não um explorador de sistema de arquivos: `/etc` responde 403.
Adicionar o mesmo repositório de novo substitui a entrada, o que na prática é um
refresh do clone.

**Persistência:** JSON em `~/.local/share/voice-assistant/`, um arquivo por
conversa. Repositórios do GitHub viram clones rasos em `.../repos/`.

## Scripts

| Comando | Descrição |
|---|---|
| `npm run dev` | Backend + frontend |
| `npm run setup` | `npm install` nos dois pacotes |
| `npm run build` | Build de produção |
| `npm run typecheck` | `tsc --noEmit` nos dois |
| `npm run lint` | ESLint nos dois |
| `npm run validate` | lint + typecheck + test + build |

## Troubleshooting

**"Nenhum material adicionado"** — o botão de conectar só funciona com pelo
menos um material. Adicione um no seletor.

**A pasta que eu quero não aparece no navegador** — ele só mostra o que está sob
`~/Projects`, sob a documentação da máquina e sob o cache de clones. Para outros
lugares, aponte `EXPLAINER_REPO_ROOTS` (separado por dois-pontos).

**O navegador não pede o microfone** — Chrome e Firefox só liberam
`getUserMedia` em `localhost` ou HTTPS. `http://127.0.0.1:5173` também vale;
um IP de rede local, não.

**"A OpenAI recusou a conexão (401)"** — o `client_secret` expirou (dura 10
minutos) ou a chave não tem acesso ao modelo realtime. Reconecte; se persistir,
confira `OPENAI_API_KEY` e rode
`curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | grep realtime`.

**O agente `pi` falha na hora** — `pi` não está no PATH.
`npm i -g @mariozechner/pi-coding-agent`, ou aponte `PI_BIN`.

**Busca na web sem resposta** — o `web_search` da Responses API caiu e o
`surf-research-skill` não está instalado. A conversa continua; o modelo avisa
que não conseguiu consultar a internet.

**A sessão cai sozinha depois de uma hora** — é o limite de sessão da Realtime
API. A transcrição está salva; basta reconectar.
