# nox-post

API que publica e agenda posts no **Instagram, Facebook, LinkedIn (perfil e página), YouTube e TikTok**. É só a API:
os apps (suíte social, DarkHub...) conectam os canais dos clientes e mandam os posts por aqui.

As integrações com as redes são adaptadas do [Postiz](https://github.com/gitroomhq/postiz-app) (AGPL-3.0), sem
NestJS, Prisma, Temporal, Redis ou Elasticsearch: um processo Node (Fastify) e um Postgres, rodando com ~200 MB.
Contrato completo em [docs/API.md](docs/API.md).

## Rodar local

Requer Node 22+, pnpm e Docker.

```bash
pnpm install
cp .env.example .env            # ajuste SECRETS_KEY e ADMIN_TOKEN
docker compose up -d postgres   # Postgres em 127.0.0.1:5450
pnpm migrate
pnpm dev                        # http://localhost:3500
```

Criar um tenant (o app que vai usar a API):

```bash
pnpm tenant:create "Suíte social" https://suite.local/webhooks/noxpost https://suite.local/canais
```

Testes: `pnpm test` (unidade) e `pnpm test:pg` (fluxo completo no Postgres local; apaga os dados das tabelas).

## Como funciona

- **Canais:** `POST /v1/channels/connect` devolve o link de autorização da rede. O retorno cai em
  `PUBLIC_URL/oauth/<rede>/callback`, a API grava um canal por conta (página, perfil, canal) com o token cifrado
  (AES-256-GCM com `SECRETS_KEY`) e redireciona para o app.
- **Posts:** `POST /v1/posts` agenda. Um worker no próprio processo pega os vencidos a cada 5 s
  (`FOR UPDATE SKIP LOCKED`, dá para ter mais de uma réplica), publica e acompanha o processamento de vídeo e
  carrossel até o fim.
- **Tokens:** renovados sozinhos antes de vencer (LinkedIn, YouTube, TikTok). Token recusado: renova e tenta uma vez;
  se não der, o canal vira `needs_reauth` e o app recebe um webhook.
- **Webhooks:** `post.published`, `post.failed`, `channel.connected`, `channel.needs_reauth`, assinados igual ao Nox,
  com outbox e retentativa.

```text
src/
  providers/   uma rede por arquivo (contrato em types.ts, registro em index.ts)
  services/    canais/OAuth, posts, worker de publicação, outbox de webhooks, mídia, tenants
  routes/      api (/v1), public (OAuth, mídia, saúde), admin
migrations/    SQL
deploy/        produção na VPS
```

**Adicionar uma rede:** crie `src/providers/<rede>.ts` implementando `Provider` (`authUrl`, `connect`, `publish` e,
se tiver processamento assíncrono, `check`; `refresh` se o token vencer), inclua o nome em `Network` e registre em
`src/providers/index.ts`. O Postiz tem mais 30 providers que servem de base (X, Threads, Pinterest, Bluesky,
Telegram, Reddit...).

## Apps das redes

O endereço de retorno de cada rede é `PUBLIC_URL/oauth/<network>/callback`. Em produção precisa ser HTTPS.

| Rede | Onde criar | Endereço de retorno | Variáveis |
|---|---|---|---|
| Facebook e Instagram | [developers.facebook.com](https://developers.facebook.com/apps) → app do tipo Empresa, produtos *Facebook Login for Business* e *Instagram Graph API* | `/oauth/facebook/callback` e `/oauth/instagram/callback` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| LinkedIn | [linkedin.com/developers](https://www.linkedin.com/developers/apps) → produtos *Share on LinkedIn* e *Sign In with LinkedIn using OpenID Connect*; para páginas, *Community Management API* (pede aprovação) | `/oauth/linkedin/callback` e `/oauth/linkedin-page/callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| YouTube | [console.cloud.google.com](https://console.cloud.google.com) → ativar *YouTube Data API v3*, tela de consentimento, credencial *Aplicativo da Web* | `/oauth/youtube/callback` | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| TikTok | [developers.tiktok.com](https://developers.tiktok.com) → *Login Kit* + *Content Posting API* (Direct Post) | `/oauth/tiktok/callback` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |

Pendências que dependem das redes, não de código:

- **Meta:** App Review das permissões (`pages_manage_posts`, `instagram_content_publish`, `business_management`...)
  e verificação da empresa. Antes disso, só contas com papel no app conseguem conectar.
- **LinkedIn:** sem o recurso de refresh token liberado no app, o token vence em 60 dias e o canal pede reconexão.
- **YouTube:** projeto não verificado publica como privado e a cota padrão (10 mil unidades/dia) dá uns 6 uploads
  por dia. Peça a auditoria e o aumento de cota.
- **TikTok:** sem auditoria, só posta `SELF_ONLY` em conta privada.

## Produção (VPS)

Mesmo esquema do Nox: a imagem é construída aqui e enviada por SSH, com Postgres próprio e rota no
caddy-docker-proxy.

1. No servidor (usuário `deploy`, alias `saas-vps`): crie `/opt/nox-post/stack.env` a partir de [deploy/stack.env.example](deploy/stack.env.example)
   (`chmod 600`). Gere os segredos com `openssl rand -base64 48`. Confirme que a rede docker `proxy` existe.
2. Aponte o DNS de `NOX_POST_DOMAIN` para a VPS.
3. Aqui: `NOX_POST_HOST=<alias ssh> bash deploy/vps-deploy.sh` (padrão `saas-vps`). O script faz build, backup do banco,
   migrations e sobe a stack `nox-post`.
4. Crie o tenant: `curl -X POST https://<dominio>/admin/tenants -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"Suíte social","webhookUrl":"https://..."}'`.

Mídia fica no volume `nox-post_media`. Backups do banco em `/opt/nox-post/backups/nox-post-*.dump` (últimos 14).

## Licença

AGPL-3.0 (arquivo [LICENSE](LICENSE)); origem do código adaptado em [NOTICE](NOTICE). Quem usa esta API
modificada pela rede tem direito ao código-fonte: este repositório é público por isso. Os apps que só chamam a API
por HTTP não são afetados.
