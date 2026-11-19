# CRM da Tá Seguros — configuração do Cloudflare

O CRM fica em `/gestao/`, atrás de uma sessão assinada. A LP existente continua em `/` e `/lp.html`; quando o backend estiver ativo, os formulários enviados nela entram na mesma lista do CRM.

## 1. Criar o banco D1

No diretório do repositório, crie um banco D1 chamado `ta-seguros-crm`. Em seguida, aplique as migrações:

```sh
npx wrangler d1 create ta-seguros-crm
npx wrangler d1 execute ta-seguros-crm --remote --file=migrations/0001_initial.sql
npx wrangler d1 execute ta-seguros-crm --remote --file=migrations/0002_users_and_assignments.sql
```

O primeiro comando mostra o identificador do banco. Guarde-o para a configuração do Pages.

## 2. Configurar Cloudflare Pages

No projeto Pages ligado ao repositório:

1. Em **Settings → Functions → D1 database bindings**, adicione o binding `DB` apontando ao banco `ta-seguros-crm`. Configure produção e preview.
2. Em **Settings → Variables and Secrets**, crie os secrets `CRM_PASSWORD` e `SESSION_SECRET`, também para produção e preview.
3. Mantenha `CRM_PASSWORD` como senha provisória de bootstrap para criar a conta `admin` no primeiro acesso depois da migração. Gere `SESSION_SECRET` com `openssl rand -base64 48`; não coloque nenhum dos dois secrets no Git.
4. Faça um novo deploy do branch com as Functions e a pasta `gestao/`.

O caminho de entrada será `https://taseguros.com.br/gestao/`. O formulário público da landing page envia para `/api/public-leads` no mesmo domínio.

## Operação e privacidade

- O CRM não usa dados de demonstração nem grava leads no navegador.
- Leads públicos entram como “Novo pedido” e guardam o consentimento e a origem `site`.
- No primeiro acesso, entre com usuário `admin` e o valor atual de `CRM_PASSWORD`. O CRM cria a conta de gestão no banco; depois desse primeiro login, a senha é validada pelo hash armazenado no D1.
- A gestão cadastra vendedores em **Equipe**, definindo nome, usuário e uma senha inicial de pelo menos 12 caracteres. Cada vendedor vê e atualiza somente leads atribuídos a ele. A gestão vê todos, atribui leads e pode suspender acessos ou redefinir senhas. A sessão expira em 12 horas e o sistema bloqueia imediatamente contas desativadas.
- Leads que chegam pelo formulário público ficam sem responsável até a gestão atribuí-los.
- O banco guarda apenas os dados informados no formulário ou pela equipe. A tela permite editar e excluir solicitações.
- O limite inicial é de 8 envios por hora por IP e 8 tentativas de login por 15 minutos. O IP não é salvo em claro; a chave temporária é derivada por HMAC e expira em até 24 horas.

Se o D1 ou os secrets ainda não estiverem configurados, o site público continua carregando; o CRM mostra que falta configurar e o formulário informa que o envio está indisponível. Não confirma pedidos que o banco não recebeu.
