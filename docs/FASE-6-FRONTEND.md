# Fase 6 — Frontend Login Fechado

## O que foi alterado

- Fluxo humano usa apenas login por e-mail e senha quando staff auth está configurado
- Modo legado (Google + chave) só aparece quando `useStaffAuth` é false (Supabase não configurado)
- Mensagens de erro específicas: credencial inválida, usuário não autorizado, usuário inativo

## Arquivos

| Ação | Arquivo |
|------|---------|
| Editado | `public/index.html` |
| Editado | `src/services/auth.service.js` (retorno com reason) |
| Editado | `src/middleware/auth.middleware.js` (repasse de mensagem) |

## Fluxo

1. **Carregamento**: `restoreSession()` chama `/auth/config`
2. Se `useStaffAuth` e Supabase configurado:
   - Oculta `loginLegacy` (Google + chave)
   - Mostra `loginStaff` (e-mail + senha)
   - Verifica sessão Supabase: `getSession()` → `/auth/me`
   - Se ok: `enterApp()`
   - Se 401: permanece na tela de login
3. Se staff auth não configurado:
   - Mostra `loginLegacy` (Google ou chave) para compatibilidade

## Tela de login (staff auth)

- Campos: E-mail, Senha
- Botão: Entrar
- Link: Esqueci minha senha
- **Não exibe**: criar conta, signup

## Mensagens de erro

| Situação | Mensagem |
|----------|----------|
| E-mail ou senha incorretos | E-mail ou senha incorretos. |
| Usuário não em StaffUser | Usuário não autorizado. Entre em contato com o administrador. |
| Usuário inativo | Usuário inativo. Entre em contato com o administrador. |
| Reset negado | E-mail não encontrado ou não autorizado... |

## Proteção da interface

- Requisições usam `Authorization: Bearer <token>` quando sessão ativa
- Em 401: `signOut()`, `location.reload()` → volta para login
- API key não é mais usada para login humano quando staff auth está ativo

## Compatibilidade

- Quando Supabase não está configurado, o modo legado (chave) continua disponível
- `ALLOW_API_KEY_FALLBACK` mantém integrações técnicas funcionando
