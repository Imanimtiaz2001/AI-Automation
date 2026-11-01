# Facebook test Page and token setup

The workflow must post to a **Page you own** (never a PlacidWay page). Until this is done, run with `PW_DRY_RUN=true`.

## 1. Create a test Page
facebook.com → *Pages* → *Create new Page* (any name, e.g. "PW Automation Demo"). Note its **Page ID** (*About → Page transparency*, or from the token step below). Put it in `.env` as `PW_FB_PAGE_ID`.

## 2. Create a Meta app
developers.facebook.com → *My Apps* → *Create App* → use case *Other* → type *Business*. In development mode the app can post to Pages you administer, which is all a demo needs (no App Review).

## 3. Get a long-lived Page access token
1. Open the **Graph API Explorer**, select your app, *User Token*, and add the permissions:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` (+ `read_insights` for clicks, + `instagram_basic`, `instagram_content_publish` if you want the Instagram cross-post).
2. *Generate Access Token* and approve for your test Page.
3. Exchange it for a long-lived user token (60 days):
   ```
   GET https://graph.facebook.com/v23.0/oauth/access_token?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-user-token}
   ```
4. Get the Page token (derived from a long-lived user token it does **not expire**; it is revoked if you change your password or remove the app):
   ```
   GET https://graph.facebook.com/v23.0/me/accounts?access_token={long-lived-user-token}
   ```
   Copy the `access_token` and `id` of your Page.
5. Check it in the *Access Token Debugger*: type **Page**, expires **Never**.

Put the token in `.env.secrets` as `FB_PAGE_ACCESS_TOKEN` (or in the **Facebook Page token** credential: Query Auth, name `access_token`).

## 4. Optional: Instagram cross-post
Connect an Instagram professional account to the Page (Page settings → Linked accounts). Find its id:
```
GET https://graph.facebook.com/v23.0/{page-id}?fields=instagram_business_account&access_token={page-token}
```
Set `PW_IG_USER_ID` to that id.

## 5. Telegram (alerts and approvals)
1. Talk to **@BotFather** → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your bot (or add it to a group), then open `https://api.telegram.org/bot<token>/getUpdates` and copy `message.chat.id` into `PW_TELEGRAM_CHAT_ID`.

## Troubleshooting
| Alert | Meaning | Fix |
|---|---|---|
| `FB_TOKEN_EXPIRED` | token invalid/revoked (Graph code 190) | repeat step 3, update the credential |
| `FB_PERMISSION` | missing `pages_manage_posts` or not a Page admin | regenerate with the permissions above |
| `FB_IMAGE_ERROR` then a link post | Facebook could not fetch the image | nothing to do; the fallback already posted |
| approval links do not open | `WEBHOOK_URL` not reachable from the phone | expose n8n (Cloudflare Tunnel/ngrok) and set `WEBHOOK_URL` |
