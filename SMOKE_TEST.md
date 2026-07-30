# Smoke Test — Voice Assistant

## Pré-requisitos
- [ ] Node.js 22+
- [ ] `OPENROUTER_API_KEY` em `.env` (na raiz ou em `backend/`) — o backend lê o
      arquivo no boot e avisa no console se a chave faltar
- [ ] `surf-research-skill` no PATH — **opcional**: sem ele a tool `web_research`
      devolve um aviso ao modelo em vez de quebrar a conversa
- [ ] Chrome ou Edge (MediaRecorder + AudioContext)

## Testes

### 1. Inicialização
- [ ] `cd backend && npm run dev` → servidor na porta 3001
- [ ] `cd frontend && npm run dev` → Vite na porta 5173
- [ ] Abrir http://localhost:5173 → layout carrega sem erros no console
- [ ] Health check: `curl http://localhost:3001/api/health` → {"status":"ok"}
- [ ] Rota inexistente: `curl http://localhost:3001/api/xyz` → 404 JSON

### 2. Conversas
- [ ] Criar nova conversa → aparece na sidebar
- [ ] Criar segunda conversa → alternar entre elas
- [ ] Deletar conversa → desaparece da sidebar
- [ ] Recarregar página → conversas persistem **e o histórico de mensagens reaparece**
- [ ] Alternar de conversa no meio de uma resposta → o stream anterior é abortado

### 3. Microfone
- [ ] Clicar botão mic → permissão solicitada
- [ ] Conceder permissão → botão mostra estado "recording"
- [ ] Falar algo → áudio capturado
- [ ] Parar gravação → estado "processing" aparece
- [ ] Negar permissão → toast de erro aparece

### 4. Chat
- [ ] Enviar mensagem por texto → resposta aparece
- [ ] Resposta em áudio toca automaticamente — **uma vez só**, sem sobreposição
- [ ] Tool calls aparecem como blocos "Ferramenta" recolhíveis, não como fala do assistente
- [ ] Falha do LLM (ex.: `OPENROUTER_CHAT_MODEL=nao/existe`) → toast de erro e
      backend continua vivo
- [ ] Conversa com 6+ respostas faladas → todos os players continuam funcionando
      (AudioContext é compartilhado)

### 5. Arquivos
- [ ] Anexar arquivo → aparece na lista
- [ ] Perguntar sobre o arquivo → resposta referencia o conteúdo
- [ ] Perguntar pelo **nome original** do arquivo → `read_file` acerta de primeira
- [ ] Anexar um `.html` e baixá-lo → vem como `application/octet-stream` +
      `Content-Disposition: attachment` (nunca renderiza na origem da API)

### 6. ⌘K
- [ ] Ctrl+K / ⌘K → command palette abre
- [ ] Digitar nome de conversa → filtra
- [ ] Selecionar → navega para a conversa
