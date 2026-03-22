# Fase 7 — Gestão de Usuários no Painel

## O que foi alterado

Tela de gestão de usuários internos no painel admin (Usuários > Usuários Internos), com listagem, criação, edição, ativação/desativação e reset de senha.

## Arquivos

| Ação | Arquivo |
|------|---------|
| Editado | `public/index.html` |

## Funcionalidades

- **Listar usuários**: exibe nome, e-mail, role, tenant, status (ativo/inativo)
- **Filtros**: por tenant, role e status (ativos/inativos)
- **Criar usuário**: modal com e-mail, senha, nome, perfil (role) e tenant
- **Editar usuário**: nome, perfil e tenant (e-mail não editável)
- **Ativar/Desativar**: botões por usuário (não é possível desativar a si mesmo)
- **Reset de senha**: define nova senha diretamente (admin)

## Acesso

- Visível apenas para **admin** quando `USE_STAFF_AUTH` está ativo
- Localização: painel Admin → Usuários → card "🔐 Usuários Internos"

## Integração

- Usa rotas `/dash/staff-users` (GET, POST, PATCH, POST activate, POST deactivate, POST reset-password)
- Protegido por `authAdmin`

## Validações

- Manager e Attendant exigem tenant
- Admin não tem tenant
- Senha mínima 6 caracteres
- E-mail único no cadastro
