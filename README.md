<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/nox-post.png">
    <img src="assets/brand/nox-post-escuro.png" alt="nox-post" width="280">
  </picture>
</p>

# nox-post

API que publica e agenda posts no **Instagram, Facebook, LinkedIn (perfil e página), YouTube e TikTok**. É só a API:
os apps conectam os canais dos clientes e mandam os posts por aqui.

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
pnpm tenant:create "Meu app" https://app.local/webhooks/noxpost https://app.local/canais
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

### Troca de domínio

Os callbacks saem do `PUBLIC_URL`, então trocar o domínio quebra o login das redes se os apps não souberem do endereço
novo. A ordem é:

1. Servir os dois domínios (`NOX_POST_DOMAIN_ALIASES` com o antigo).
2. Em cada app, **adicionar** os callbacks novos sem apagar os antigos: `/oauth/facebook/callback` e
   `/oauth/instagram/callback` (Meta), `/oauth/linkedin/callback` e `/oauth/linkedin-page/callback` (LinkedIn),
   `/oauth/youtube/callback` (Google Cloud) e `/oauth/tiktok/callback` (TikTok, que também pede a verificação do domínio
   novo).
3. Trocar o `PUBLIC_URL` e reiniciar a API.
4. Depois de um tempo sem uso, apagar os callbacks antigos e tirar o alias.


## Produção

O deploy está em [deploy/](deploy): `deploy/vps-deploy.sh` faz build, backup do banco, migrations e sobe a stack
atrás de um proxy reverso. As variáveis ficam no modelo [deploy/stack.env.example](deploy/stack.env.example).

## Licença

AGPL-3.0 (arquivo [LICENSE](LICENSE)); origem do código adaptado em [NOTICE](NOTICE). Quem usa esta API
modificada pela rede tem direito ao código-fonte: este repositório é público por isso. Os apps que só chamam a API
por HTTP não são afetados.

A logo e o símbolo em [assets/brand](assets/brand) são marcas da Nox e não fazem parte da licença do código.
