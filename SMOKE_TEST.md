# Smoke Test — Voice Assistant

## Pré-requisitos
- [ ] Node.js 22+
- [ ] `OPENROUTER_API_KEY` em .env
- [ ] `surf-research-skill` instalado e configurado
- [ ] Chrome ou Edge (File System Access API)

## Testes

### 1. Inicialização
- [ ] `cd backend && npm run dev` → servidor na porta 3001
- [ ] `cd frontend && npm run dev` → Vite na porta 5173
- [ ] Abrir http://localhost:5173 → layout carrega sem erros no console
- [ ] Health check: `curl http://localhost:3001/api/health` → {"status":"ok"}

### 2. Conversas
- [ ] Criar nova conversa → aparece na sidebar
- [ ] Criar segunda conversa → alternar entre elas
- [ ] Deletar conversa → desaparece da sidebar
- [ ] Recarregar página → conversas persistem

### 3. Microfone
- [ ] Clicar botão mic → permissão solicitada
- [ ] Conceder permissão → botão mostra estado "recording"
- [ ] Falar algo → áudio capturado
- [ ] Parar gravação → estado "processing" aparece
- [ ] Negar permissão → toast de erro aparece

### 4. Chat
- [ ] Enviar mensagem por texto → resposta aparece
- [ ] Resposta em áudio toca automaticamente
- [ ] Tool calls aparecem como mensagens de sistema

### 5. Arquivos
- [ ] Anexar arquivo → aparece na lista
- [ ] Perguntar sobre o arquivo → resposta referencia o conteúdo

### 6. ⌘K
- [ ] Ctrl+K / ⌘K → command palette abre
- [ ] Digitar nome de conversa → filtra
- [ ] Selecionar → navega para a conversa
