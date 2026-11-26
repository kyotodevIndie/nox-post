<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/nox-post.png">
    <img src="assets/brand/nox-post-escuro.png" alt="nox-post" width="280">
  </picture>
</p>

# nox-post

API que publica e agenda posts no **Instagram, Facebook, LinkedIn (perfil e página), YouTube, TikTok, X, Threads,
Pinterest, Reddit, Google Business Profile, Dribbble, Tumblr, Slack, Discord, Telegram, Mastodon, Bluesky, Lemmy,
Farcaster, Nostr, VK, Kick, Twitch, DEV, Medium, Hashnode e WordPress**. É só a API: os apps conectam os canais dos
clientes e mandam os posts por aqui.

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

- **Canais:** `POST /v1/channels/connect` devolve o link de autorização da rede (ou, nas redes por credenciais como
  Telegram, Bluesky e Mastodon, recebe o token e grava na hora). O retorno cai em
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

**Adicionar uma rede:** crie `src/providers/<rede>.ts` implementando `Provider` (`authUrl` e `connect` para OAuth, ou
`credentialFields` e `connectWith` para token/instância; `validate`, `publish` e, se tiver processamento assíncrono,
`check`; `refresh` se o token vencer), inclua o nome em `Network` e registre em `src/providers/index.ts`. OAuth no
padrão usa os auxiliares de `oauth.ts` e as validações comuns ficam em `rules.ts`.

## Apps das redes

O endereço de retorno de cada rede é `PUBLIC_URL/oauth/<network>/callback`. Em produção precisa ser HTTPS.

| Rede | Onde criar | Endereço de retorno | Variáveis |
|---|---|---|---|
| Facebook e Instagram | [developers.facebook.com](https://developers.facebook.com/apps) → app do tipo Empresa, produtos *Facebook Login for Business* e *Instagram Graph API* | `/oauth/facebook/callback` e `/oauth/instagram/callback` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| LinkedIn | [linkedin.com/developers](https://www.linkedin.com/developers/apps) → produtos *Share on LinkedIn* e *Sign In with LinkedIn using OpenID Connect*; para páginas, *Community Management API* (pede aprovação) | `/oauth/linkedin/callback` e `/oauth/linkedin-page/callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| YouTube | [console.cloud.google.com](https://console.cloud.google.com) → ativar *YouTube Data API v3*, tela de consentimento, credencial *Aplicativo da Web* | `/oauth/youtube/callback` | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| TikTok | [developers.tiktok.com](https://developers.tiktok.com) → *Login Kit* + *Content Posting API* (Direct Post) | `/oauth/tiktok/callback` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| X | [developer.x.com](https://developer.x.com) → app com OAuth 2.0, tipo *Web App* (confidencial), permissão *Read and write* | `/oauth/x/callback` | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| Threads | [developers.facebook.com](https://developers.facebook.com/apps) → caso de uso *Acessar a API do Threads* (`threads_basic`, `threads_content_publish`) | `/oauth/threads/callback` | `THREADS_APP_ID`, `THREADS_APP_SECRET` |
| Pinterest | [developers.pinterest.com](https://developers.pinterest.com/apps) (acesso *Standard* para publicar fora do modo de teste) | `/oauth/pinterest/callback` | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` |
| Reddit | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → app do tipo *web app* | `/oauth/reddit/callback` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| Google Business Profile | [console.cloud.google.com](https://console.cloud.google.com) → pedir acesso à *Business Profile API*, ativar *My Business Account Management*, *Business Information* e *Google My Business API* | `/oauth/gmb/callback` | `GMB_CLIENT_ID`, `GMB_CLIENT_SECRET` |
| Dribbble | [dribbble.com/account/applications](https://dribbble.com/account/applications) | `/oauth/dribbble/callback` | `DRIBBBLE_CLIENT_ID`, `DRIBBBLE_CLIENT_SECRET` |
| Tumblr | [tumblr.com/oauth/apps](https://www.tumblr.com/oauth/apps) | `/oauth/tumblr/callback` | `TUMBLR_CLIENT_ID`, `TUMBLR_CLIENT_SECRET` |
| Slack | [api.slack.com/apps](https://api.slack.com/apps) → *OAuth & Permissions*, escopo `incoming-webhook`, distribuição pública | `/oauth/slack/callback` | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| VK | [id.vk.com/about/business](https://id.vk.com/about/business/go) → app Web com acesso a `wall` e `photos` | `/oauth/vk/callback` | `VK_CLIENT_ID` |
| Kick | [kick.com/settings/developer](https://kick.com/settings/developer) | `/oauth/kick/callback` | `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` |
| Twitch | [dev.twitch.tv/console](https://dev.twitch.tv/console/apps) | `/oauth/twitch/callback` | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |

Discord, Telegram, Mastodon, Bluesky, Lemmy, Farcaster, Nostr, DEV, Medium, Hashnode e WordPress não pedem app no
servidor: cada conta entra com o próprio token (veja a tabela de credenciais em [docs/API.md](docs/API.md)).

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
