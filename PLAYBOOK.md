# Playbook — Construindo um assistente de voz local React + IA

*Um plano operacional para construir uma aplicação local React/Node.js com entrada por microfone,
transcrição via OpenRouter Whisper, raciocínio por DeepSeek v4 pro com tool calling, pesquisa web
via surf-research-skill delegada ao pi, busca de arquivos locais, e resposta em áudio com auto-play.*

---

## Como usar este documento

### O que ele é

Um **método operacional** para construir um sistema novo — não modernizar legado. Contém análise
das ferramentas disponíveis, decisões de arquitetura com justificativa, decomposição em cards e
ondas, e uma estratégia de verificação. A ordem das partes é a ordem de execução.

### O que NÃO é

- Não é especificação de produto — não descreve "o que o usuário final vê", mas como construir.
- Não é um plano Waterfall — as ondas são paralelizáveis onde o grafo permite.
- Não cobre deploy, autenticação multi-usuário, nem persistência em nuvem — o escopo é local,
  single-user, na máquina do desenvolvedor.

### ✍️ Prescrições marcadas

Onde uma regra é decisão de arquitetura e não decorrência natural, está marcada **✍️ prescrito**.
As demais seguem de restrições objetivas (API, browser, latência).

---

# Parte I — Análise inicial (antes de existir tarefa)

## 1. O que estamos construindo — em uma frase

**Um assistente de voz local:** o usuário anexa arquivos de contexto, fala pelo microfone, o
áudio é transcrito, a pergunta é processada pelo DeepSeek v4 pro com capacidade de disparar
pesquisa web (surf-research-skill) ou busca de arquivos locais via tool calling, e a resposta
volta em áudio com auto-play — com múltiplas conversas persistentes.

## 2. As dez perguntas da análise inicial

| # | Pergunta | Resposta | Sem ela, o que quebra |
|---|---|---|---|
| Q1 | Do que o sistema é feito? | Browser React app + servidor Node.js local + OpenRouter API | sem fatiamento |
| Q2 | Como o usuário atravessa o sistema? | Abre o app → cria/abre conversa → anexa arquivos → clica microfone → fala → ouve resposta. Loop. | sem UX definível |
| Q3 | Quais regras de negócio não são inferíveis? | Nenhuma — é ferramenta genérica, não sistema de domínio | — |
| Q4 | Qual o modelo de dados? | Conversas (id, título, data, mensagens[]), Mensagens (role, content, audio_url, tool_calls, timestamp), Arquivos (path, conversation_id). JSON em `~/.local/share/voice-assistant/` | sem persistência |
| Q5 | Quem mais depende do que vamos mexer? | Ninguém — projeto greenfield, sem dependentes | sem risco |
| Q6 | Como o sistema recebe identidade? | Single-user local — não há autenticação. Token OpenRouter em variável de ambiente. | sem acesso à API |
| Q7 | O que é risco e o que é dívida? | Risco: DeepSeek v4 pro bug de streaming com tool calling. Dívida: autoplay policy do browser. | sem mitigação |
| Q8 | O que não veio no material? | O usuário não especificou: (a) se quer Electron ou browser, (b) form factor exato do layout, (c) se quer suporte a imagens nos anexos. **Decisões tomadas:** browser (não Electron), layout de chat com painel lateral, imagens como anexos futuros (F6). | premissas documentadas |
| Q9 | O que dá para verificar localmente × o que exige API? | Tudo que não depende de OpenRouter é verificável offline (UI, CRUD, tool calling mock). A qualidade de transcrição e TTS só se verifica com API. | gate dimensionado |
| Q10 | Qual stack e faseamento? | React 19 + Vite + Motion UI (frontend), Node.js 22 + Express + TypeScript (backend), OpenRouter (STT + LLM + TTS), surf-research-skill CLI (tools). Faseamento: scaffold → backend → frontend → integração. | — |

## 3. Blast radius — exclusividade total

Projeto greenfield. Nenhum sistema externo depende dele. Nenhum código legado.
O único "blast radius" relevante é o **filesystem do usuário** — o sistema vai ler
arquivos anexados e executar `find`/`grep` no diretório do projeto. Isso exige:

- **Sandbox de paths**: o servidor Node.js só acessa arquivos dentro do diretório
  da conversa ou caminhos explicitamente anexados. Nunca caminhos arbitrários do
  sistema.
- **Nunca executar comandos shell com input do modelo** — tool calls do DeepSeek
  são mapeadas para funções predefinidas, nunca para `eval` ou shell cru.

## 4. Inventário por papel

| Componente | Papel | Localização |
|---|---|---|
| React SPA | Interface do usuário (chat, microfone, arquivos) | `frontend/src/` |
| Node.js Express server | API REST + orquestração de tools | `backend/src/` |
| OpenRouter API | STT (Whisper), LLM (DeepSeek v4 pro), TTS (melhor disponível) | externo |
| surf-research-skill CLI | Pesquisa web sob demanda | `~/.config/surf/` (já instalado) |
| Filesystem local | Persistência de conversas, arquivos anexados | `~/.local/share/voice-assistant/` |
| Browser APIs | MediaRecorder, AudioContext, File System Access | runtime |

## 5. A stack — pesquisado, decidido, registrado

### STT (Speech-to-Text)

| Opção | Veredito | Por quê |
|---|---|---|
| OpenRouter Whisper (`/api/v1/audio/transcriptions`) | ✅ **Escolhido** | Precisão alta, cobrança por segundo de áudio, sem depender de chave separada |
| Browser Web Speech API (`SpeechRecognition`) | ❌ Rejeitado | Qualidade variável por navegador, sem controle de modelo, envia áudio para servidor do Google |
| Whisper local | ❌ Rejeitado | Exige GPU ou latência alta em CPU; fere o requisito "local leve" para o STT |

**Decisão:** OpenRouter Whisper. Modelo: `openai/whisper-large-v3` (ou o melhor disponível no momento).
Áudio: MediaRecorder → WebM (codec opus) → enviado direto (Whisper aceita WebM). Sem conversão intermediária.

### LLM (Large Language Model)

| Opção | Veredito | Por quê |
|---|---|---|
| DeepSeek v4 pro (via OpenRouter) | ✅ **Escolhido** | Suporte a tool calling, baixo custo, alta qualidade em raciocínio |
| Claude Sonnet 4 | ❌ Rejeitado | Mais caro; tool calling comparável mas latência maior |
| GPT-4o | ❌ Rejeitado | Custo maior; OpenAI não é o fornecedor preferido |

**⚠️ Risco conhecido:** DeepSeek v4 pro tem bug com streaming + tool calling (respostas vazias após
tool calls). **Mitigação:** usar **non-streaming** para toda a rodada de tool calling. Streaming só
na resposta final (pós-tools), se aplicável. O fallback é non-streaming para tudo.

### TTS (Text-to-Speech)

| Opção | Veredito | Por quê |
|---|---|---|
| OpenRouter TTS (melhor disponível) | ✅ **Escolhido** | Mistral e Google Gemini lideram em naturalidade. Single API key. |
| ElevenLabs | ❌ Rejeitado | API key adicional; custo mais alto |
| Browser SpeechSynthesis | ❌ Rejeitado | Vozes robóticas; sem controle de qualidade |

**Decisão:** OpenRouter TTS, modelo selecionado dinamicamente (tentar Mistral, fallback Google).
Formato de saída: MP3. Auto-play via AudioContext previamente desbloqueado.

### Frontend

| Opção | Veredito | Por quê |
|---|---|---|
| React 19 + Vite | ✅ **Escolhido** | Build rápido, HMR, ecossistema maduro |
| Motion UI (shadcn registry) | ✅ **Escolhido** | Componentes prontos animados; catálogo com tabs, sheet, toast, command palette |
| Tailwind CSS + shadcn tokens | ✅ **Escolhido** | Design system semântico; segue a cascata Motion UI |
| Electron | ❌ Rejeitado | Complexidade desnecessária; browser File System Access API é superior para arquivos |
| Next.js | ❌ Rejeitado | SSR desnecessário para app local; Vite é mais leve |

### Backend

| Opção | Veredito | Por quê |
|---|---|---|
| Node.js 22 + Express | ✅ **Escolhido** | Simples, maduro, mesmo runtime do frontend |
| TypeScript | ✅ **Escolhido** | Tipagem para contratos de API e tool calling |
| Fastify | ❌ Rejeitado | Overkill para ~10 endpoints |
| Bun | ❌ Rejeitado | Ecossistema ainda imaturo para child_process e streaming |

### Pontos de troca barata ✍️ prescrito

| Ponto | Custo da reversão | Mecanismo de isolamento |
|---|---|---|
| Provedor de STT (Whisper → outro) | Trocar 1 arquivo (`stt.ts`), zero mudança no frontend | Interface `transcribe(audio: Buffer): Promise<string>` |
| Provedor de LLM (DeepSeek → Claude) | Trocar 1 arquivo (`llm.ts`), zero mudança nos tools | Interface `chat(messages, tools): Promise<Response>` |
| Provedor de TTS (OpenRouter → ElevenLabs) | Trocar 1 arquivo (`tts.ts`), zero mudança no player | Interface `synthesize(text: string): Promise<Buffer>` |
| Storage (filesystem → SQLite) | Trocar 1 módulo (`storage.ts`), migração de dados | Interface `ConversationStore` com CRUD |
| UI framework (Motion UI → outro) | Copiar pasta `components/motion-ui/` + reescrever wrappers | Wrappers próprios, nunca editar source instalado |

## 6. Tool calling — as ferramentas que o DeepSeek v4 pro pode disparar ✍️ prescrito

O modelo recebe estas tools na chamada inicial. Se ele retornar `tool_calls`, o backend
executa e reenvia os resultados. Ciclo: `user message → [tool_calls] → results → [tool_calls] → ... → final response`.

| Tool | Descrição | Executor | Custo/Latência |
|---|---|---|---|
| `web_research` | Pesquisa web via surf-research-skill | `surf-research-skill search "<query>" --max 5 --json` no shell | 2-10s, credits Tavily/Parallel |
| `search_project_files` | Busca padrão em arquivos do projeto | `find`/`grep` restrito ao diretório da conversa | <1s |
| `read_file` | Lê conteúdo de arquivo específico | `fs.readFile` restrito ao diretório anexado | <100ms |
| `list_attachments` | Lista arquivos anexados à conversa | `fs.readdir` no diretório da conversa | <10ms |

**Regra dura:** Nenhum tool executado diretamente do output do modelo. Todo tool call passa por um
mapper que valida: (a) o nome da função existe, (b) os argumentos são do tipo esperado, (c) paths
estão dentro da sandbox. Tool não mapeado → erro retornado ao modelo, não executado.

### Fluxo do tool calling

```
User: "pesquise sobre React 19 server components e compare com o que está no meu arquivo notes.txt"
       │
       ▼
DeepSeek v4 pro (com tools definidas)
       │
       ├─ tool_call: web_research({ query: "React 19 server components 2025" })
       │     └─ backend executa: surf-research-skill search "..." --max 5 --json
       │        resultado → enviado de volta ao modelo
       │
       ├─ tool_call: search_project_files({ pattern: "server component", path: "notes.txt" })
       │     └─ backend executa: grep -i "server component" <conversation_dir>/notes.txt
       │        resultado → enviado de volta ao modelo
       │
       └─ resposta final (texto síntese)
            │
            └─ backend envia texto para TTS → áudio → frontend
```

## 7. Critério de parada da análise

- [x] Stack decidida com alternativas documentadas e motivo de rejeição
- [x] Ferramentas de tool calling definidas com executor e custo
- [x] Modelo de dados definido
- [x] Blast radius mapeado (sandbox de paths)
- [x] Riscos catalogados com mitigação (DeepSeek streaming bug, autoplay policy)
- [x] Posso escrever o card raiz sem citar tecnologia de destino além do runtime

---

# Parte II — Arquitetura

## 8. Visão geral de componentes

```
┌─────────────────────────────────────────────────────┐
│                   Browser (React)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │ Conversas│ │   Chat   │ │ Painel de Arquivos   │ │
│  │ (Tabs)   │ │(Mensagens)│ │(Sheet/Drawer)       │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
│  ┌──────────────────────────────────────────────┐   │
│  │  Barra de Controle: [🎤 Mic] [📎 Anexar]    │   │
│  └──────────────────────────────────────────────┘   │
│  MediaRecorder │ AudioContext │ File System Access   │
└──────────────┬──────────────────────────────────────┘
               │ HTTP + Server-Sent Events (streaming)
┌──────────────▼──────────────────────────────────────┐
│              Node.js Backend (Express)               │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────────┐  │
│  │  /stt  │ │ /chat  │ │  /tts  │ │ /conversations│ │
│  │Whisper │ │DeepSeek│ │OpenRtr │ │   CRUD       │  │
│  └────────┘ └───┬────┘ └────────┘ └─────────────┘  │
│                 │                                    │
│  ┌──────────────▼───────────────────────────────┐   │
│  │           Tool Executor                       │   │
│  │  web_research → surf-research-skill           │   │
│  │  search_files → find/grep (sandboxed)         │   │
│  │  read_file    → fs.readFile (sandboxed)       │   │
│  │  list_files   → fs.readdir (sandboxed)        │   │
│  └──────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────┐   │
│  │         Storage (filesystem JSON)            │   │
│  │  ~/.local/share/voice-assistant/             │   │
│  │    conversations/<id>.json                   │   │
│  │    attachments/<conv-id>/*                   │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## 9. Estrutura de diretórios

```
voice-assistant/
├── frontend/                  # React + Vite + Motion UI
│   ├── src/
│   │   ├── App.tsx            # Layout raiz + temas
│   │   ├── components/
│   │   │   ├── ui/            # Wrappers Motion UI (nunca editar source instalado)
│   │   │   │   ├── ChatBubble.tsx
│   │   │   │   ├── MicButton.tsx
│   │   │   │   ├── FilePanel.tsx
│   │   │   │   ├── ConversationTabs.tsx
│   │   │   │   └── AudioPlayer.tsx
│   │   │   └── motion-ui/    # Instalado pelo shadcn CLI (NÃO editar)
│   │   ├── hooks/
│   │   │   ├── useAudioRecorder.ts
│   │   │   ├── useConversation.ts
│   │   │   ├── useAutoPlay.ts
│   │   │   └── useFileAttachment.ts
│   │   ├── lib/
│   │   │   ├── api.ts         # Cliente HTTP para o backend
│   │   │   └── audio.ts       # Utilitários de áudio
│   │   ├── types/
│   │   │   └── index.ts       # Tipos compartilhados
│   │   └── motion.theme.ts    # Config de springs e transições
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── package.json
├── backend/
│   ├── src/
│   │   ├── index.ts           # Entry point Express
│   │   ├── routes/
│   │   │   ├── stt.ts         # POST /api/stt
│   │   │   ├── chat.ts        # POST /api/chat (SSE streaming)
│   │   │   ├── tts.ts         # POST /api/tts
│   │   │   ├── conversations.ts # CRUD /api/conversations
│   │   │   └── files.ts       # Upload/list/read /api/files
│   │   ├── services/
│   │   │   ├── openrouter.ts  # Cliente HTTP para OpenRouter (STT + LLM + TTS)
│   │   │   ├── tool-executor.ts # Executor de tool calls
│   │   │   └── storage.ts     # Persistência em JSON
│   │   ├── tools/
│   │   │   ├── index.ts       # Definições das tools (schema OpenAI)
│   │   │   ├── web-research.ts
│   │   │   ├── search-files.ts
│   │   │   ├── read-file.ts
│   │   │   └── list-files.ts
│   │   ├── middleware/
│   │   │   ├── sandbox.ts     # Validação de paths
│   │   │   └── error-handler.ts
│   │   └── types/
│   │       └── index.ts
│   └── package.json
├── .env.example               # OPENROUTER_API_KEY=...
└── README.md
```

## 10. API endpoints

| Method | Path | Body | Response | Descrição |
|---|---|---|---|---|
| `POST` | `/api/stt` | `multipart: audio` | `{ text: string }` | Envia WebM para Whisper |
| `POST` | `/api/chat` | `{ conversation_id, message? }` | SSE stream | Inicia ciclo de chat (com tools) |
| `POST` | `/api/tts` | `{ text: string }` | `audio/mpeg` | Sintetiza texto em fala |
| `GET` | `/api/conversations` | — | `Conversation[]` | Lista conversas |
| `POST` | `/api/conversations` | `{ title }` | `Conversation` | Cria nova conversa |
| `GET` | `/api/conversations/:id` | — | `Conversation` | Obtém uma conversa |
| `DELETE` | `/api/conversations/:id` | — | `204` | Remove conversa |
| `POST` | `/api/files/:convId` | `multipart: files[]` | `FileInfo[]` | Upload de arquivos |
| `GET` | `/api/files/:convId` | — | `FileInfo[]` | Lista arquivos |
| `GET` | `/api/files/:convId/:filename` | — | `text/plain` | Lê conteúdo |

O endpoint `/api/chat` é o core. Ele:
1. Carrega o histórico da conversa + nova mensagem (ou mensagem vazia se for continuar tool calls)
2. Monta o prompt com tools definidas
3. Chama OpenRouter (DeepSeek v4 pro) non-streaming
4. Se resposta tem `tool_calls` → executa → adiciona ao histórico → volta ao passo 3
5. Se resposta tem `content` → envia TTS + retorna texto + áudio
6. Salva conversa atualizada

## 11. Autoplay de áudio — a solução ✍️ prescrito

**Problema:** Browsers bloqueiam `audio.play()` sem user gesture. O fluxo é: usuário clica
mic → fala → espera processamento (vários segundos) → áudio chega. O user gesture expirou.

**Solução:** Usar o padrão `AudioContext.resume()`:

```typescript
// No clique do botão de microfone (user gesture):
const audioCtx = new AudioContext();
await audioCtx.resume(); // "desbloqueia" o contexto de áudio

// Mais tarde, quando o áudio TTS chegar:
const buffer = await audioCtx.decodeAudioData(ttsMp3Buffer);
const source = audioCtx.createBufferSource();
source.buffer = buffer;
source.connect(audioCtx.destination);
source.start(0); // toca imediatamente, sem restrição de autoplay
```

**Por que funciona:** `AudioContext.resume()` chamado dentro de um user gesture coloca o
context em estado "running". A partir daí, `source.start()` funciona sem restrição — mesmo
minutos depois. **Não é o mesmo que `<audio>.play()`** — o Web Audio API tem regras diferentes.

**⚠️ Limitação:** Requer decodificar o MP3 inteiro antes de tocar (não faz streaming).
Para arquivos de áudio pequenos (<30s de fala), latência é <500ms. Aceitável.

**Alternativa mantida:** Se `AudioContext` falhar (browsers antigos), fallback para
`<audio>` com `autoplay` atributo, que funciona SE o usuário já interagiu com a página
antes (o que sempre é verdade, pois ele clicou no mic).

## 12. Motion UI — a cascata aplicada a este projeto

Seguindo a cascata motion-plus-ui:

### Passo 1 — Procurar no catálogo

| Necessidade | Catálogo tem? | Componente |
|---|---|---|
| Abas para conversas | ✅ | `smooth-tabs` (com crossfade direcional) |
| Painel lateral de arquivos | ✅ | `sheet` (bottom sheet com drag-to-dismiss) |
| Modal de confirmação (deletar conversa) | ✅ | `overlay` + `sheet` |
| Toast de notificação | ✅ | `toast-stack` |
| Loading durante processamento | ✅ | `skeleton` |
| Comando rápido (⌘K) | ✅ | `command-palette` |
| Indicador de gravação | ❌ | Custom (MicButton) |
| Balão de mensagem (chat bubble) | ❌ | Custom (ChatBubble) |
| Player de áudio inline | ❌ | Custom (AudioPlayer) |
| Área de upload de arquivos | ❌ | Custom (FilePanel internals) |

### Passo 2 — Instalar

```bash
npx shadcn@latest add @motion/smooth-tabs
npx shadcn@latest add @motion/sheet
npx shadcn@latest add @motion/overlay
npx shadcn@latest add @motion/toast-stack
npx shadcn@latest add @motion/skeleton
npx shadcn@latest add @motion/command-palette
npx shadcn@latest add @motion/motion-theme
```

### Passo 3 — Compor o layout

```
┌─────────────────────────────────────────────────────┐
│ [🎤] Voice Assistant              [+ Nova Conversa] │
├──────────┬──────────────────────────────────────────┤
│ Conv 1   │                                          │
│ Conv 2 ● │  ┌─────────────────────────────────┐     │
│ Conv 3   │  │ 🧑 User: pesquise sobre...       │     │
│          │  └─────────────────────────────────┘     │
│          │  ┌─────────────────────────────────┐     │
│          │  │ 🤖 Assistant: [áudio] Com base   │     │
│          │  │ na pesquisa, React 19...          │     │
│ [📎]     │  └─────────────────────────────────┘     │
│ Arquivos │                                          │
│ • doc.md │  ┌─────────────────────────────────┐     │
│ • img.png│  │ 🔈 Reproduzir áudio             │     │
│          │  └─────────────────────────────────┘     │
│          │                                          │
│          │  [🎤 Clique para gravar]  [📎 Anexar]   │
└──────────┴──────────────────────────────────────────┘
```

Onde:
- **Conversas**: `smooth-tabs` vertical à esquerda (adaptado do componente horizontal)
- **Chat**: área central com `ChatBubble` custom
- **Arquivos**: painel inferior/acoplado, ou `sheet` que abre de baixo
- **Controles**: barra fixa inferior com `MicButton` e botão de anexar

### Passo 4 — Código novo (só o que o catálogo não cobre)

| Componente | Por que custom | Classes/Animações |
|---|---|---|
| `ChatBubble` | Não existe no catálogo | `bg-secondary text-secondary-foreground rounded-2xl`, `useMotionUITransition("gentle")` para entrada |
| `MicButton` | Não existe no catálogo | `bg-primary text-primary-foreground rounded-full`, pulso com `animate-pulse` durante gravação |
| `AudioPlayer` | Não existe no catálogo | `bg-muted rounded-lg`, progresso com `progress-bar` do catálogo |
| `FilePanel` internals | Sheet fornece o container; lista de arquivos é custom | `divide-y divide-border` |

**Justificativa (passo 5):** O catálogo Motion UI cobre layout, navegação e feedback (tabs,
sheet, toast, skeleton, command palette, progress-bar). Faltam componentes específicos de
chat (bolhas de mensagem, botão de microfone pulsante) porque são específicos do domínio.
Nenhum deles exige CSS de layout complexo — são variações de borda, padding e animação.

## 13. Modelo de dados

```typescript
// backend/src/types/index.ts

interface Conversation {
  id: string;                    // UUID
  title: string;                 // "Nova conversa" ou resumo automático
  created_at: string;            // ISO 8601
  updated_at: string;            // ISO 8601
  messages: Message[];
  attachments: Attachment[];     // Referência, não conteúdo
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;        // null quando é só tool_call
  tool_calls?: ToolCall[];       // Presente em assistant messages
  tool_call_id?: string;         // Presente em tool messages
  audio_url?: string;            // Caminho para arquivo de áudio TTS (assistant only)
  timestamp: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: "web_research" | "search_project_files" | "read_file" | "list_attachments";
    arguments: string;           // JSON string
  };
}

interface Attachment {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  path: string;                  // Relativo ao dir da conversa
  added_at: string;
}
```

## 14. Gerenciamento de contexto ✍️ prescrito

DeepSeek v4 pro tem janela de contexto de 128K tokens. Conversas longas precisam de trimming.

**Estratégia:** Sliding window com sumarização.

1. **Até 8K tokens:** mantém histórico completo
2. **8K-32K tokens:** mantém últimas 16 mensagens + sumário das antigas injetado como system message
3. **>32K tokens:** mantém últimas 8 mensagens + sumário + as 3 mensagens mais antigas com attachments citados

O sumário é gerado pelo próprio DeepSeek (chamada separada, sem tools) quando a conversa cruza 8K.
O sumário anterior é preservado; cada novo sumário incorpora o anterior ("rolling summary").

**⚠️ Limitação:** sumarização custa uma chamada extra de API. Só dispara no save da conversa, não em
tempo real.

---

# Parte III — A árvore de tarefas

## 15. Fases

```
F0: Scaffold & infra         ← estrutura de diretórios, config, CI
F1: Backend core             ← API, OpenRouter, tools, storage
F2: Frontend shell           ← Vite + React + Motion UI setup + layout
F3: Conversas & arquivos     ← CRUD, persistência, upload, File System Access
F4: Pipeline de áudio        ← gravação, STT, TTS, auto-play
F5: Tool calling             ← integração DeepSeek tools, surf-research-skill, busca arquivos
F6: Integração & UX          ← juntar tudo, estados de loading/erro, polish
F7: Verificação              ← gate local, testes, autoplay em browsers
```

## 16. Cards

### F0 — Scaffold & infra (3 cards, onda W0)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F0-01 | Estrutura de diretórios e package.json | — | `frontend/package.json`, `backend/package.json`, `tsconfig.json`s | — |
| F0-02 | Config de Vite + Tailwind + shadcn + Motion UI | F0-01 | `vite.config.ts`, `tailwind.config.ts`, `components.json`, `motion.theme.ts` | F0-01 |
| F0-03 | Config de ESLint + Prettier + .env.example | — | `.eslintrc`, `.prettierrc`, `.env.example`, `.gitignore` | — |

### F1 — Backend core (5 cards, onda W1...W3)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F1-01 | Entry point Express + tipos base | F0-01 | `backend/src/index.ts`, `backend/src/types/index.ts` | F0-01 |
| F1-02 | Módulo OpenRouter (STT + LLM + TTS) | F1-01 | `backend/src/services/openrouter.ts` | F1-01 |
| F1-03 | Sandbox middleware | F1-01 | `backend/src/middleware/sandbox.ts` | F1-01 |
| F1-04 | Rotas: conversations CRUD | F1-01, F1-03 | `backend/src/routes/conversations.ts`, `backend/src/services/storage.ts` | F1-03 |
| F1-05 | Rotas: files upload/list/read | F1-01, F1-03 | `backend/src/routes/files.ts` | F1-03 |

### F2 — Frontend shell (4 cards, onda W1...W3)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F2-01 | App shell: layout + tema + provider | F0-02 | `App.tsx`, layout com tabs + área central | F0-02 |
| F2-02 | Instalar e wrappear componentes Motion UI | F0-02 | Wrappers em `components/ui/`, componentes em `components/motion-ui/` | F0-02 |
| F2-03 | Cliente HTTP para API | — | `frontend/src/lib/api.ts` | — |
| F2-04 | Hooks: useConversation, useAudioRecorder, useAutoPlay, useFileAttachment | F2-03 | hooks tipados e testáveis | F2-03 |

### F3 — Conversas & arquivos (3 cards, onda W4)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F3-01 | UI de conversas: tabs + criar/deletar | F2-01, F2-03, F2-04 | `ConversationTabs.tsx`, integração com API | F2-01, F1-04 |
| F3-02 | UI de chat: bolhas de mensagem | F2-01, F2-04 | `ChatBubble.tsx`, renderização de markdown | F2-01 |
| F3-03 | UI de arquivos: upload + lista | F2-01, F2-03 | `FilePanel.tsx`, File System Access API | F2-01, F1-05 |

### F4 — Pipeline de áudio (4 cards, onda W5...W6)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F4-01 | Gravação: MediaRecorder → WebM buffer | F2-04 | `useAudioRecorder.ts` (implementação real) | F2-04 |
| F4-02 | STT: enviar áudio → receber texto | F1-02 | `backend/src/routes/stt.ts`, UI de transcrição | F1-02, F4-01 |
| F4-03 | TTS: texto → áudio → player | F1-02 | `backend/src/routes/tts.ts`, `AudioPlayer.tsx` | F1-02 |
| F4-04 | Auto-play: AudioContext desbloqueio + reprodução | F4-03 | `useAutoPlay.ts` (implementação real) | F4-03 |

### F5 — Tool calling (3 cards, onda W7)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F5-01 | Definições de tools (schema OpenAI) | F1-02 | `backend/src/tools/index.ts` com 4 tools | F1-02 |
| F5-02 | Tool executor + integração surf-research-skill | F5-01 | `backend/src/services/tool-executor.ts`, `backend/src/tools/web-research.ts` | F5-01 |
| F5-03 | Tools de busca de arquivos (find/grep/read) | F5-01, F1-03 | `backend/src/tools/search-files.ts`, `read-file.ts`, `list-files.ts` | F5-01, F1-03 |

### F6 — Integração & UX (5 cards, onda W8...W9)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F6-01 | Rota /api/chat: integrar LLM + tools + TTS | F1-02, F5-02, F5-03, F4-03 | `backend/src/routes/chat.ts` (fluxo completo) | F1-02, F5-02, F5-03, F4-03 |
| F6-02 | UI de gravação: botão de microfone com estados | F4-01, F2-02 | `MicButton.tsx` (idle → recording → processing → done) | F4-01 |
| F6-03 | Estados de loading e erro globais | F2-01, F2-02 | Skeleton durante chat, toast de erro | F2-02 |
| F6-04 | Command palette (atalhos, busca em conversas) | F2-02 | Integração do `command-palette` | F2-02 |
| F6-05 | Sumarização de conversas longas | F6-01 | Trigger de sumário quando >8K tokens | F6-01 |

### F7 — Verificação (2 cards, onda W10)

| ID | Título | Entradas | Saídas | Dependências |
|---|---|---|---|---|
| F7-01 | Gate local: lint + typecheck + testes | — | Script `validate.sh` rodando todos os checks | F0-03 |
| F7-02 | Smoke test: fluxo completo microfone → áudio resposta | F6-01, F6-02 | Teste E2E ou checklist manual | F6-01, F6-02 |

### Cards de infra (fora de onda, sem worktree)

| ID | Título | O que faz |
|---|---|---|
| INFRA-01 | Instalar Motion UI registry + shadcn | `npx shadcn@latest add @motion/*` para todos os componentes listados |
| INFRA-02 | Setup do surf-research-skill no projeto | `surf-research-skill project-config` para timeout de bash |

## 17. Grafo e ondas

```
Nível topológico (calculado):

Nível 0: F0-01, F0-03
Nível 1: F0-02, F1-01, F2-03
Nível 2: F1-02, F1-03, F2-01, F2-02
Nível 3: F1-04, F1-05, F2-04
Nível 4: F3-01, F3-02, F3-03
Nível 5: F4-01
Nível 6: F4-02, F4-03
Nível 7: F4-04, F5-01
Nível 8: F5-02, F5-03
Nível 9: F6-01
Nível 10: F6-02, F6-03, F6-04, F6-05
Nível 11: F7-01, F7-02
```

```
Mapa de ondas:

W0:  F0-01, F0-03, INFRA-01, INFRA-02  (scaffold + infra, 4 cards paralelos)
W1:  F0-02, F1-01, F2-03               (base técnica, 3 cards)
W2:  F1-02, F1-03, F2-01, F2-02        (serviços + shell, 4 cards — a mais larga)
W3:  F1-04, F1-05, F2-04               (CRUD + hooks, 3 cards)
W4:  F3-01, F3-02, F3-03               (UI conversas/chat/arquivos, 3 cards)
W5:  F4-01                             (gravação — sozinha, é fundação do pipeline)
W6:  F4-02, F4-03                      (STT + TTS — consomem F4-01, 2 cards)
W7:  F4-04, F5-01                      (auto-play + definições de tools, 2 cards)
W8:  F5-02, F5-03                      (execução de tools, 2 cards)
W9:  F6-01                             (rota /chat — neck, toca tudo, sozinha)
W10: F6-02, F6-03, F6-04, F6-05        (UX final, 4 cards)
W11: F7-01, F7-02                      (verificação, 2 cards)
```

**Total: 27 cards (25 de desenvolvimento + 2 de infra) em 12 ondas.**

**Estreiteza das ondas justificada:**

| Onda | Cards | Motivo da largura |
|---|---|---|
| W0 | 4 | Scaffold — nenhum depende de outro |
| W2 | 4 | Serviços e shell não compartilham arquivos |
| W5 | 1 | Fundação do pipeline de áudio — todos os cards seguintes dependem |
| W6 | 2 | Consomem W5, mas são independentes entre si |
| W9 | 1 | Neck — `/api/chat` toca LLM + tools + TTS + storage. Altíssimo acoplamento. |
| W10 | 4 | UX final — consomem W9 mas são independentes entre si |

**Caminho crítico** (9 ondas): F0-01 → F1-01 → F1-02 → F4-01 → F4-02/F4-03 → F4-04 → F5-01 → F5-02/F5-03 → F6-01 → F6-02 → F7-02

**Onda de composição:** W9 (F6-01) — toca `openrouter.ts`, `tool-executor.ts`, `storage.ts`,
`stt.ts`, `tts.ts`. Exige contrato congelado das interfaces antes de começar.

---

# Parte IV — Execução com agentes

## 18. Instruções de execução

Cada card segue o template do Playbook original, adaptado:

- `<ultrathink>`: onde concentrar raciocínio
- `<contexto>`: o que este card resolve no fluxo do assistente
- `<entradas>`: arquivos e skills a carregar
- `<o_que_fazer>`: 3-5 passos numerados
- `<restricoes>`: proibições específicas
- `<criterios_aceitacao>`: comandos com exit code esperado

### Template de card

```xml
<task id="F?-??" nome="..." onda="W?" worktree="voice-assistant">
  <ultrathink>…</ultrathink>
  <contexto>…</contexto>
  <entradas>…</entradas>
  <o_que_fazer>
    1. …
    2. …
  </o_que_fazer>
  <restricoes>…</restricoes>
  <criterios_aceitacao>
    cd backend && npx tsc --noEmit     # exit 0
    cd frontend && npx tsc --noEmit    # exit 0
  </criterios_aceitacao>
</task>
```

## 19. Regras específicas deste projeto

### Regra 1 — Sandbox de paths (vale para TODO card que toca filesystem)

```
PROIBIDO acessar arquivos fora de:
  - <project_root>/backend/
  - <project_root>/frontend/
  - ~/.local/share/voice-assistant/

Qualquer path vindo do cliente DEVE ser validado: resolver path real,
rejeitar se contiver "..", rejeitar se fora do allowlist.
```

### Regra 2 — Tool calls nunca viram shell direto

```
Modelo retorna { name: "web_research", arguments: { query: "..." } }
→ Executor monta: surf-research-skill search "..." --max 5 --json
→ NUNCA: eval(arguments.query) nem exec(string_from_model)

Modelo NÃO decide o comando. O mapper decide.
```

### Regra 3 — Tokens nunca no código

```
OPENROUTER_API_KEY em .env (gitignorado).
MOTION_TOKEN em variável de ambiente global.
Nenhum segredo em arquivo versionado.
```

### Regra 4 — Motion UI: editar wrapper, nunca source instalado

```
components/motion-ui/**  → do CLI, NÃO editar
components/ui/**         → wrappers, editar à vontade
```

### Regra 5 — Non-streaming para tool calls

```
DeepSeek v4 pro tool calling bug:
  - Streaming + tools → respostas vazias após tool call
  - Solução: usar stream: false em TODA chamada com tools
  - Streaming só na resposta final (após tools), se quiser UX de digitação
```

---

# Parte V — Verificação

## 20. Gate local

Script `validate.sh`:

```bash
#!/bin/bash
set -e

echo "=== Lint ==="
cd backend  && npx eslint src/ --max-warnings 0
cd frontend && npx eslint src/ --max-warnings 0

echo "=== TypeCheck ==="
cd backend  && npx tsc --noEmit
cd frontend && npx tsc --noEmit

echo "=== Build ==="
cd frontend && npx vite build

echo "=== Tests ==="
cd backend  && npx vitest run
cd frontend && npx vitest run

echo "=== Gate OK ==="
```

**Ferramenta ausente = VERMELHO.** `eslint`, `tsc`, `vite`, `vitest` — se não instalado, falha
explícita, nunca "pulado".

## 21. Smoke test mínimo (F7-02)

Checklist manual, executável na máquina local:

1. `cd backend && npm run dev` — servidor sobe na porta 3001
2. `cd frontend && npm run dev` — Vite sobe na porta 5173
3. Abrir `http://localhost:5173` → vê layout com tabs e área central
4. Clicar "Nova conversa" → nova tab aparece
5. Clicar botão de microfone → permissão de microfone solicitada
6. Falar "Olá, teste de voz" → texto transcrito aparece no chat
7. Resposta em áudio toca automaticamente
8. Clicar "Anexar" → selecionar arquivo → arquivo aparece no painel
9. Falar "leia o arquivo que anexei" → resposta referencia o conteúdo do arquivo
10. Falar "pesquise sobre o tempo em São Paulo" → resposta menciona fontes web

## 22. Invariantes

| Invariante | Verificação |
|---|---|
| Nenhum `.env` versionado | `grep -r "OPENROUTER_API_KEY" --include="*.ts" --include="*.json"` → vazio |
| `components/motion-ui/` sem edições manuais | `git diff -- components/motion-ui/` → vazio |
| Backend compila sem erros | `cd backend && npx tsc --noEmit` → exit 0 |
| Frontend compila sem erros | `cd frontend && npx tsc --noEmit` → exit 0 |
| Nenhum `eval` ou `exec` com string do modelo | `grep -r "eval\|exec(" backend/src/tools/` → vazio |

---

# Parte VI — Memória e incerteza

## 23. Decisões assumidas (ledger)

| ID | Assunção | Se divergir, o que muda |
|---|---|---|
| AB-001 | DeepSeek v4 pro tool calling funciona non-streaming | Se o bug afetar também non-streaming: trocar para Claude Sonnet (troca de 1 linha em `openrouter.ts`) |
| AB-002 | AudioContext.resume() desbloqueia autoplay nos browsers alvo (Chrome, Firefox, Edge) | Se falhar em algum browser: fallback para `<audio>` com `autoplay` após user gesture |
| AB-003 | OpenRouter Whisper aceita WebM (codec opus) | Se rejeitar: converter para WAV com `ffmpeg` no backend (custa ~200ms) |
| AB-004 | OpenRouter TTS responde em < 5s | Se latência > 10s: streaming de TTS ou troca de provedor |
| AB-005 | surf-research-skill está instalado e configurado | Se não: instalar via `surf-research-skill setup` (card INFRA-02 cobre) |
| AB-006 | Browser File System Access API disponível (Chrome/Edge) | Se Firefox sem suporte: fallback para `<input type="file">` tradicional |

## 24. O que este plano NÃO cobre

- **Deploy em produção** — é ferramenta local, não servidor público
- **Autenticação multi-usuário** — single user por design
- **Suporte a imagens nos anexos** (visão computacional) — futuro
- **Streaming de TTS** — o plano usa buffer completo
- **Mobile** — foco em desktop browser
- **Internacionalização** — interface em inglês (código), voz em português (configurável)
- **CI/CD** — gate local apenas; CI externo não configurado

---

# Apêndices

## Apêndice A — Card F0-01 completo (exemplo)

```xml
<task id="F0-01" nome="Estrutura de diretórios e package.json" onda="W0" worktree="voice-assistant">
  <ultrathink>Escolher versões exatas de React, Node, TypeScript e Motion. Um erro aqui contamina todas as dependências futuras.</ultrathink>

  <contexto>Projeto greenfield: assistente de voz local React + Node.js.
  Stack: React 19 + Vite + Motion UI (frontend), Node.js 22 + Express + TypeScript (backend).</contexto>

  <entradas>PLAYBOOK.md (este documento) — Partes I e II.</entradas>

  <o_que_fazer>
    1. Criar estrutura de diretórios: frontend/src/{components,hooks,lib,types}, backend/src/{routes,services,tools,middleware,types}
    2. Criar frontend/package.json com: react@^19, react-dom@^19, vite@^6, typescript@^5, tailwindcss@^4, motion@^12, @motionplus/core@^2
    3. Criar backend/package.json com: express@^4, typescript@^5, tsx@^4, openai@^4 (usado para OpenRouter), multer@^1, uuid@^10
    4. Criar tsconfig.json em ambos (strict, ESNext, paths alias @/ → src/)
    5. Criar .env.example com OPENROUTER_API_KEY= (placeholder)
  </o_que_fazer>

  <restricoes>
    PROIBIDO versões beta/alpha de qualquer pacote.
    PROIBIDO "motion-plus" do npmjs (tombstone) — usar "@motionplus/core" com alias.
    PROIBIDO framer-motion — usar "motion/react".
  </restricoes>

  <criterios_aceitacao>
    ls frontend/package.json backend/package.json frontend/tsconfig.json backend/tsconfig.json .env.example  # exit 0
    cd frontend && npm install  # exit 0
    cd backend && npm install   # exit 0
  </criterios_aceitacao>
</task>
```

## Apêndice B — Definições das tools (schema OpenAI)

```typescript
// backend/src/tools/index.ts
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "web_research",
      description: "Search the web for current information. Use for facts, news, documentation, or anything not in the local files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (max 400 chars)" },
          max_results: { type: "number", description: "Max results (1-10, default 5)" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_project_files",
      description: "Search for a pattern in attached project files using grep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Grep pattern (supports regex)" },
          path: { type: "string", description: "Optional: restrict to a specific file or subdirectory" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full content of an attached file.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Name of the attached file" }
        },
        required: ["filename"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_attachments",
      description: "List all files attached to the current conversation.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  }
];
```

## Apêndice C — Checklist de arranque (Semana 0)

- [ ] Node.js 22+ instalado
- [ ] Token OpenRouter configurado em `.env`
- [ ] Token Motion+ no ambiente global (`echo $MOTION_TOKEN`)
- [ ] surf-research-skill instalado e com keys configuradas
- [ ] Navegador Chrome/Edge (File System Access API)
- [ ] `git init` no diretório do projeto
- [ ] `.gitignore` com `node_modules/`, `.env`, `dist/`, `~/.local/share/voice-assistant/`

## Apêndice D — Motion UI cascade para este projeto (resumo executivo)

```bash
# 1. Setup (uma vez por projeto)
node ~/.claude/skills/motion-plus-ui/scripts/ensure-setup.mjs

# 2. Instalar componentes
npx shadcn@latest add @motion/smooth-tabs
npx shadcn@latest add @motion/sheet
npx shadcn@latest add @motion/overlay
npx shadcn@latest add @motion/toast-stack
npx shadcn@latest add @motion/skeleton
npx shadcn@latest add @motion/command-palette
npx shadcn@latest add @motion/progress-bar
npx shadcn@latest add @motion/motion-theme

# 3. Wrappers custom (em components/ui/)
# ChatBubble.tsx — bg-secondary, rounded-2xl, useMotionUITransition("gentle")
# MicButton.tsx — bg-primary, rounded-full, animate-pulse durante recording
# AudioPlayer.tsx — bg-muted, rounded-lg, usa progress-bar do catálogo
# FilePanel.tsx — dentro de Sheet, lista com divide-y divide-border

# 4. Provider no App.tsx
# <MotionUIThemeProvider> com motion.theme.ts importado
```

## Apêndice E — Template de card resumido para uso em agentes

Para cards que não precisam do XML completo (tarefas simples), use este formato condesado:

```markdown
## F?-?? — Título

**Onda:** W?
**Dependências:** F?-??, F?-??

### Objetivo
Uma frase sobre o que entregar.

### Entradas
- Arquivos: `backend/src/...`
- Skills: (se aplicável)

### O que fazer
1. Passo 1
2. Passo 2

### Restrições
- PROIBIDO...

### Aceitação
```bash
comando  # exit 0
```
```

---

## Nota final

Este plano descreve **27 cards em 12 ondas**, mais 2 cards de infra. O total estimado
de linhas: ~3.000 (backend) + ~2.500 (frontend) + ~500 (config) = **~6.000 linhas**.

O caminho crítico tem 9 ondas. As ondas W0, W2, W4, W6, W8 e W10 são paralelizáveis
(2-4 cards concorrentes cada). A onda W9 é o gargalo — um único card que amarra todo
o pipeline — e deve receber o agente mais capaz.

**Regra final:** o gate local (`validate.sh`) roda após CADA merge de card.
Merge limpo não prova integração funcional — o gate prova.
