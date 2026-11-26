# nox-post: contrato da API

API de publicação em redes sociais para os nossos SaaS. Cada SaaS é um **tenant**: tem
uma chave de API, conecta os canais dos clientes dele, agenda posts e recebe webhooks quando o post sai ou falha.

Base: `https://<api>`. JSON UTF-8. Datas em ISO 8601 com fuso (`2026-11-20T12:00:00-03:00`).
Toda rota `/v1` exige `Authorization: Bearer pnox_...`.

## 1. Redes

`GET /v1/networks` lista as redes ligadas no servidor: as de OAuth aparecem quando o app da rede está configurado;
as de credenciais aparecem sempre. Cada item traz `connect` (`oauth` ou `credentials`) e, nas de credenciais,
`credentialFields` (campo com `?` no fim é opcional).

```json
{ "networks": [{ "network": "x", "label": "X", "connect": "oauth" },
  { "network": "bluesky", "label": "Bluesky", "connect": "credentials", "credentialFields": ["identifier", "appPassword", "service?"] }] }
```

Redes por OAuth:

| network | O que publica | Observações |
|---|---|---|
| `facebook` | texto, link, fotos, um vídeo | uma conexão traz todas as páginas autorizadas |
| `instagram` | foto, carrossel (2 a 10), Reels, Stories | conta Profissional ligada a uma Página do Facebook |
| `linkedin` | texto, imagens, um vídeo | perfil pessoal |
| `linkedin-page` | texto, imagens, um vídeo | páginas que a pessoa administra; exige o produto Community Management API no app |
| `youtube` | um vídeo (Shorts se for vertical e curto) | `settings.title` obrigatório |
| `tiktok` | um vídeo | sem auditoria do app, só `SELF_ONLY` |
| `x` | texto (280), até 4 imagens | sem vídeo por enquanto; a API do X é paga por uso |
| `threads` | texto (500), imagem, vídeo, carrossel (até 20) | app da Threads API (separado do Facebook) |
| `pinterest` | pin de imagem (1 a 5) | `settings.board` obrigatório; sem vídeo |
| `reddit` | post de texto ou de link | `settings.subreddit` e `settings.title` obrigatórios; sem mídia |
| `gmb` | novidade com até 1 foto e botão | Google Business Profile; uma conexão traz todos os locais |
| `dribbble` | shot com 1 imagem | `settings.title` obrigatório; tamanhos de imagem fixos do Dribbble |
| `tumblr` | texto e até 10 imagens | uma conexão traz todos os blogs |
| `slack` | texto e imagens | o canal é escolhido na tela do Slack (webhook) |
| `vk` | texto e até 10 imagens no mural | `settings.group_id` posta numa comunidade |
| `kick` | mensagem no chat do canal (500) | só texto |
| `twitch` | mensagem no chat do canal (500) | só texto |

Redes por credenciais (o tenant manda os dados, a API confere na rede e grava cifrado):

| network | credentials | O que publica |
|---|---|---|
| `discord` | `webhookUrl` (Canal → Integrações → Webhooks) | texto (2.000), imagens como embed, vídeo como link |
| `telegram` | `botToken` (@BotFather), `chatId` (`@canal` ou id; o bot precisa ser admin) | texto (4.096), foto, vídeo, álbum (até 10, legenda 1.024) |
| `mastodon` | `instance`, `accessToken` (Preferências → Desenvolvimento; escopos `read:accounts write:statuses write:media`) | texto (500), até 4 mídias |
| `bluesky` | `identifier` (handle ou e-mail), `appPassword` (senha de app), `service?` (padrão `https://bsky.social`) | texto (300), até 4 imagens; links clicáveis |
| `lemmy` | `instance`, `username`, `password` (sem 2FA) | post em comunidade; `settings.community` e `settings.title` obrigatórios |
| `farcaster` | `apiKey` e `signerUuid` do Neynar (signer aprovado) | cast (1.024 bytes), até 2 mídias como embed |
| `nostr` | `privateKey` (`nsec...` ou hex), `relays?` (wss://, separados por vírgula) | nota kind 1; mídia vira URL no texto |
| `devto` | `apiKey` | artigo em Markdown; `settings.title` obrigatório |
| `medium` | `token` (só quem já tem: o Medium não emite tokens novos) | artigo em Markdown; `settings.title` obrigatório |
| `hashnode` | `token` (Personal Access Token) | artigo em Markdown; uma conexão traz todos os blogs |
| `wordpress` | `site`, `username`, `appPassword` (senha de aplicação, WordPress 5.6+) | post em HTML; a 1ª imagem vira destaque |

Endereços de instância (`instance`, `site`, `service`) precisam ser HTTPS.

## 2. Conectar canais

```http
POST /v1/channels/connect
{ "network": "instagram", "returnUrl": "https://app.suite.com/canais", "ref": "persona-42" }
→ { "url": "https://www.facebook.com/v25.0/dialog/oauth?..." }
```

Mande a pessoa para `url`. Depois de autorizar, a rede volta para a API, que grava os canais e redireciona para
`returnUrl` (ou o `oauthReturnUrl` do tenant) com:

- sucesso: `?status=ok&network=instagram&channels=<id>,<id>&ref=persona-42`
- erro: `?status=error&network=instagram&error=<mensagem>&ref=persona-42`

Sem URL de retorno, a API mostra uma página simples de "Conta conectada". O link vale 1 hora e é de uso único.
`ref` é livre (ex.: id da persona) e fica gravado no canal. Reconectar a mesma conta atualiza o canal existente.

Redes por credenciais conectam na hora, sem redirecionamento:

```http
POST /v1/channels/connect
{ "network": "telegram", "credentials": { "botToken": "123456:ABC...", "chatId": "@meucanal" }, "ref": "persona-42" }
→ 201 { "channels": [{ "id": "uuid", "network": "telegram", ... }] }
```

Credencial recusada pela rede ou campo faltando: `422 CREDENTIALS_INVALID` com a mensagem. Mandar `credentials`
para uma rede de OAuth dá `400 OAUTH_REQUIRED`; chamar sem `credentials` uma rede de credenciais dá
`400 CREDENTIALS_REQUIRED`. O webhook `channel.connected` sai igual nos dois caminhos.

| Rota | O que faz |
|---|---|
| `GET /v1/channels?network=&ref=&status=` | lista (sem os desconectados) |
| `GET /v1/channels/:id` | um canal |
| `PATCH /v1/channels/:id` `{ "ref": "..." }` | troca o ref |
| `DELETE /v1/channels/:id` | desconecta: apaga os tokens e cancela os posts agendados |

```json
{ "id": "uuid", "network": "instagram", "externalId": "1784...", "name": "Loja", "username": "loja",
  "picture": "https://...", "status": "active", "ref": "persona-42", "lastError": null,
  "expiresAt": null, "createdAt": "...", "updatedAt": "..." }
```

`status`: `active`, `needs_reauth` (token vencido ou revogado: chame o connect de novo) ou `disabled`.
A API renova sozinha os tokens que têm refresh (LinkedIn, YouTube, TikTok, X, Threads, Pinterest, Reddit,
Google Business, Tumblr, VK, Kick, Twitch). Nas redes por credenciais, credencial revogada deixa o canal em `needs_reauth`:
mande as credenciais de novo.

## 3. Mídia

A Meta (e Threads, Pinterest, Google Business, Tumblr, Slack, Discord, Telegram) baixa a mídia pela URL, então ela precisa ser pública. Use URLs suas (CDN, S3) ou envie para a API:

```http
PUT /v1/media?filename=video.mp4
Content-Type: application/octet-stream
<bytes>
→ 201 { "media": { "id": "uuid", "url": "https://<api>/media/<id>/video.mp4", "type": "video", "mime": "video/mp4", "size": 123 } }
```

Extensões: jpg, jpeg, png, webp, gif, mp4, mov, m4v, webm, pdf. Limite: `MEDIA_MAX_MB` (padrão 1024).
`DELETE /v1/media/:id` apaga. O arquivo é servido com suporte a Range.

## 4. Posts

```http
POST /v1/posts
{
  "channelId": "uuid",
  "text": "Legenda do post",
  "media": [{ "url": "https://.../a.jpg", "type": "image", "alt": "descrição" }],
  "settings": {},
  "scheduledAt": "2026-11-20T12:00:00-03:00",
  "externalRef": "post-981"
}
→ 201 { "post": { ... } }   (200 com o post existente se o externalRef já foi usado)
```

- Sem `scheduledAt`, publica na hora (o worker roda a cada 5 s).
- `externalRef` é a chave de idempotência do seu lado: repetir o POST não duplica.
- A API valida pelas regras da rede e responde `422 POST_INVALID` com a mensagem.

`settings` por rede:

| network | campos |
|---|---|
| facebook | `link`, `title` (vídeo) |
| instagram | `post_type`: `post` (padrão) ou `story`. Um vídeo sozinho vira Reels. `media[].thumbnail` vira a capa do Reels |
| youtube | `title` (obrigatório, até 100), `privacy` (`public` padrão, `unlisted`, `private`), `tags` (lista), `categoryId` (padrão `22`), `madeForKids` |
| tiktok | `privacy_level` (padrão `SELF_ONLY`; `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`), `disable_comment`, `disable_duet`, `disable_stitch`, `brand_content_toggle`, `brand_organic_toggle`, `is_aigc` |
| linkedin, linkedin-page, x, threads, kick, twitch | nenhum |
| pinterest | `board` (obrigatório: id ou nome da pasta), `title` (até 100), `link` |
| reddit | `subreddit` e `title` (obrigatórios), `url` (vira post de link), `flair_id`, `nsfw` |
| gmb | `cta_type` (`BOOK`, `ORDER`, `SHOP`, `LEARN_MORE`, `SIGN_UP`, `CALL`), `cta_url`, `language` (padrão `pt-BR`) |
| dribbble | `title` (obrigatório), `tags` (lista) |
| tumblr | `tags` (lista) |
| vk | `group_id` (posta no mural da comunidade) |
| discord | `username`, `avatar_url` (sobrescrevem os do webhook) |
| telegram | `parse_mode` (`HTML` ou `MarkdownV2`), `disable_notification` |
| mastodon | `visibility` (`public` padrão, `unlisted`, `private`, `direct`), `spoiler_text`, `language` |
| bluesky | `langs` (ex.: `["pt"]`) |
| lemmy | `community` e `title` (obrigatórios), `url` (padrão: a 1ª mídia), `nsfw` |
| farcaster | `channel` (id do canal, ex.: `dev`) |
| nostr | `hashtags` (lista) |
| devto, medium, hashnode, wordpress | `title` (obrigatório), `tags` (lista), `canonical_url`, `draft`; devto: `series`, `organization_id`; wordpress: `status`, `excerpt` |

Ciclo de vida: `scheduled` → `publishing` → (`processing`) → `published` ou `failed`. `cancelled` se cancelado.

| Rota | O que faz |
|---|---|
| `GET /v1/posts?status=&channelId=&limit=&before=` | lista, mais novos primeiro (`before` = `createdAt` do último, para paginar) |
| `GET /v1/posts/:id` | um post |
| `PATCH /v1/posts/:id` | muda `text`, `media`, `settings` ou `scheduledAt` (só `scheduled`) |
| `DELETE /v1/posts/:id` | cancela (só `scheduled`) |
| `POST /v1/posts/:id/retry` `{ "scheduledAt"?: "..." }` | recoloca um `failed` na fila |

```json
{ "id": "uuid", "channelId": "uuid", "externalRef": "post-981", "text": "...", "media": [], "settings": {},
  "scheduledAt": "...", "status": "published", "remoteId": "1790...", "remoteUrl": "https://www.instagram.com/p/...",
  "error": null, "publishedAt": "...", "createdAt": "...", "updatedAt": "..." }
```

A API **nunca republica sozinha**. Se o processo cair no meio do envio, o post vira `failed` com
"o envio foi interrompido no meio" depois de 2 horas: confira na rede antes de usar o retry.

## 5. Webhooks

`POST <webhookUrl do tenant>`, no mesmo formato do Nox:

| Header | Valor |
|---|---|
| `X-Nox-Event-Id` | UUID do evento (igual a `body.id`) |
| `X-Nox-Timestamp` | Unix epoch em segundos |
| `X-Nox-Signature` | `v1=` + hex(HMAC-SHA256(webhookSecret, `<timestamp>.<corpo cru>`)) |

```json
{ "id": "uuid", "type": "post.published", "occurredAt": "...", "data": { "post": { ... } } }
```

| type | data |
|---|---|
| `channel.connected` | `{ network, ref, channels: [canal] }` |
| `channel.needs_reauth` | `{ channel, reason }` |
| `post.published` | `{ post }` |
| `post.failed` | `{ post, reason: fatal \| reauth \| transient \| internal, detail }` |

Verifique a assinatura sobre o corpo cru, rejeite timestamp fora de ±5 min, trate duplicatas pelo `X-Nox-Event-Id`
e responda 2xx em até 10 s. Falhou: nova tentativa com espera de 30 s, 1 min, 2 min... até 6 h, 12 tentativas.

## 6. Erros

```json
{ "error": { "code": "POST_INVALID", "message": "Instagram: precisa de pelo menos uma imagem ou vídeo" } }
```

`400 VALIDATION` (com `details.issues`), `400 OAUTH_REQUIRED` / `CREDENTIALS_REQUIRED`, `401 UNAUTHORIZED`, `404 *_NOT_FOUND`, `409 POST_NOT_EDITABLE` /
`POST_NOT_CANCELLABLE` / `POST_NOT_RETRYABLE` / `CHANNEL_DISABLED`, `413 MEDIA_TOO_LARGE`, `415 MEDIA_TYPE_UNSUPPORTED`,
`422 POST_INVALID`, `422 CREDENTIALS_INVALID`.

## 7. Admin

`Authorization: Bearer <ADMIN_TOKEN>`.

| Rota | O que faz |
|---|---|
| `POST /admin/tenants` `{ name, webhookUrl?, oauthReturnUrl? }` | cria; devolve `apiKey` e `webhookSecret` **uma vez só** |
| `GET /admin/tenants` | lista |
| `PATCH /admin/tenants/:id` `{ name?, webhookUrl?, oauthReturnUrl?, active? }` | altera |
| `POST /admin/tenants/:id/rotate` `{ webhookSecret?: true }` | chave nova (a antiga para na hora) |
| `GET /admin/events?status=dead&tenantId=` | webhooks |
| `POST /admin/events/:id/requeue` | reenvia um webhook |
