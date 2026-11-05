# Feedloop

**An AI support agent that doesn't just answer — it settles the money.**

Feedloop is a drop-in chat widget for small online businesses. Customers type what they want; the AI classifies it and answers from the owner's knowledge base. With PayPal it also settles payment issues: it verifies the payment with PayPal, refunds within the owner's limits, and sells from the price table mid-conversation. Anything beyond the limits becomes a one-tap approval in the inbox. When several customers report the same payment problem, Feedloop groups them and can open one pull request that fixes the cause.

> **Status:** built during the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (Oct 18 – Nov 10, 2026). Runs on the PayPal **sandbox** — no real money moves. Live demo: **https://feedloop-demo.vercel.app**

## Try it in 3 minutes

You need a PayPal sandbox **personal** (buyer) account. The login is in the Devpost submission's **Testing instructions**.

1. **Buy a plan.** Open [feedloop-demo.vercel.app/pricing](https://feedloop-demo.vercel.app/pricing). Under **Starter ($9)**, press **Buy with PayPal**. On the PayPal page, **log in** as the sandbox buyer (do not pay as a guest with a card). You land on the receipt page. It shows the **PayPal order ID** — copy it.
2. **Ask for a refund in chat.** Open the chat bubble (bottom right) and send these two messages:
   ```
   I bought the wrong plan by mistake. Please refund the full amount.
   ```
   ```
   Order id <your PayPal order ID>, email <the sandbox buyer email>
   ```
3. **See the result.** The $9 refund is inside the limits, so the agent refunds it on its own and shows a refund card in the chat. Reload the receipt page: it now says **Payment refunded**.

**If the refund waits for approval instead:** other judges share the same sandbox buyer, and the limit is one auto refund per customer per 30 days. Then the chat says the refund is waiting for the owner. To approve it yourself: **Sign in with Google**, open **Bots**, press **Try the demo bot** (this makes you an approver of the demo bot), and press **Approve $9** on the refund card in the **Inbox**.

**Owner view.** After joining the demo bot, open **Dashboard**: the **PayPal** block shows payment inquiries and auto refunds (last 7 days) and refunds waiting for approval, and the **Payment ledger** lists every purchase and refund. In the **Inbox**, a payment conversation shows its **Payment activity** panel.

## What it does

From before the hackathon:

- **One-line install.** Paste a script tag; the widget appears on your site.
- **Understands intent.** Every message is classified (bug, question, feature request, complaint …) and grouped with similar ones.
- **Answers from your knowledge.** The bot replies only from what you've written; anything it doesn't know is handed to a human.
- **Closes the loop.** When a report is fixed, the person who sent it gets notified. If a GitHub repo is connected, Feedloop opens a pull request with a proposed fix — a human decides whether to merge.
- **Owner dashboard.** Inbox, grouping, knowledge editing, bot settings.

### Built during the hackathon

- **Checkout in chat and on `/pricing`.** The agent offers a product from the price table and shows a **Pay with PayPal** card; `/pricing` has the same checkout. PayPal Orders create and capture; the receipt page is `/pricing/receipt/[orderId]`.
- **Refunds in chat.** The visitor gives the PayPal order ID and the email they paid with. Both must match before the agent discusses the payment. The server reads the capture from PayPal, then refunds inside the owner's limits or sends the request to the inbox for approval.
- **Approval card in the inbox.** It shows the amount, the PayPal capture, and which limit was exceeded. Owners and approvers approve or reject it with one tap.
- **Webhooks.** `POST /api/paypal/webhook/[botId]` checks PayPal's signature, captures orders whose buyer closed the tab, and keeps orders in sync with refunds and reversals made outside Feedloop. Dispute events (`CUSTOMER.DISPUTE.*`) are only stored; Feedloop does not act on disputes yet.
- **Payment problems → one fix PR.** The refund reason goes through the existing classifier, so repeated payment problems are grouped and can become one root-cause pull request.
- **Owner dashboard for money.** PayPal numbers, a payment ledger (AG Grid Community table on screens 1280px and wider, cards below), and the inbox **Payment activity** panel.
- **Refund Studio (`/dashboard/refunds`).** An AG Studio dashboard over a fixed 90-day sample store, marked as sample data, for screens 1024px and wider. No sign-in. The Refund Watch agent, on Claude, finds the rising refund reason, says where its fix is, and places an alert widget on the dashboard. Needs `AG_STUDIO_LICENSE_KEY` and `STUDIO_ANTHROPIC_API_KEY` at build time.
- **Per-bot PayPal settings tab.** Paste your own sandbox keys (Feedloop verifies them), the webhook registers itself, and you set the limits and two switches: **Pause automatic refunds** and **Ask me before every refund**.
- **English first, with an EN / KO toggle** (next-intl). No language prefix in URLs. The widget follows the visitor's browser language, or a fixed `data-locale="en|ko"` on the script tag.
- **"Try the demo bot"** button that makes a signed-in user an approver of the demo bot (`/api/demo/join`).

Everything built during the hackathon: [`pre-hackathon-baseline...main`](https://github.com/wineny/feedloop/compare/pre-hackathon-baseline...main). The baseline tag `pre-hackathon-baseline` points to commit `190428e`, the open-source edition published at the start of the hackathon.

## Guardrail

The agent moves money on its own only inside limits the owner sets. Defaults: refunds up to **$20**, within **14 days** of purchase, **$100 per day**, **one refund per customer per 30 days**. A refund also waits for approval if the payment has an open dispute, if the dispute check fails, or if either switch is on.

- **The server decides, not the model.** Amount, currency and purchase date come from PayPal's capture, read by the server. The model only passes on the visitor's reason (and an amount for a partial refund). The sentences that announce a refund (done / waiting / declined) are fixed server text.
- **One Postgres function decides and reserves.** `payment_action_open_refund` checks the limits and writes the action row *before* PayPal is called, in one transaction. Two "refund me" messages at the same time can never both execute.
- **Idempotent PayPal calls.** Refunds and captures go through our own REST client ([`src/lib/paypal/client.ts`](src/lib/paypal/client.ts)) with a `PayPal-Request-Id`, so a retry cannot refund twice.
- **Server tools, each bound to one bot and one conversation.** The payment agent has four of them: `find_my_payment`, `get_payment_status`, `create_checkout` and `request_refund` ([`visitor-tools.ts`](src/lib/paypal/visitor-tools.ts)).
- **PayPal Agent Toolkit for read-only lookups (sandbox bots).** Two more tools, `paypal_get_order` and `paypal_get_refund`, run the toolkit's `get_order` and `get_refund` through our AI SDK 7 adapter ([`toolkit.ts`](src/lib/paypal/toolkit.ts)). A server guard sits in front of them. Nothing is read until `find_my_payment` has verified a payment (order ID + email) in this conversation. `paypal_get_order` calls the toolkit with the server's verified order ID, never an ID from the model. `paypal_get_refund` only reads refund IDs that Feedloop recorded for that capture. Results are cut down to a whitelist of fields, so payee, fee and payer-account fields are never returned. The model never sees the toolkit's raw tools. The write tools are blocked twice (allowlist + name filter), and the raw get tools run only inside the guard.
- **Money-moving calls never go through the LLM toolkit.** Capture and refund stay on our own server tools and REST client, behind the guardrail RPC and `PayPal-Request-Id`. The toolkit's own write tools would let a prompt-injected visitor pick any amount, skip the limits and leave no audit row.

## PayPal APIs used

All calls go through our own REST client, [`src/lib/paypal/client.ts`](src/lib/paypal/client.ts), except the two Agent Toolkit lookups in the first two rows.

| PayPal API / endpoint | What Feedloop uses it for | Code |
|---|---|---|
| **Agent Toolkit** `get_order` → `GET /v2/checkout/orders/{id}` | Chat tool `paypal_get_order`: details of the verified order (when it was paid, what was bought, captures and refunds). Sandbox bots only, guarded, fields whitelisted | [`visitor-tools.ts`](src/lib/paypal/visitor-tools.ts), [`toolkit.ts`](src/lib/paypal/toolkit.ts) |
| **Agent Toolkit** `get_refund` → `GET /v2/payments/refunds/{id}` | Chat tool `paypal_get_refund`: PayPal status and date of a refund recorded on the verified capture. Sandbox bots only, guarded, fields whitelisted | [`visitor-tools.ts`](src/lib/paypal/visitor-tools.ts), [`toolkit.ts`](src/lib/paypal/toolkit.ts) |
| `POST /v1/oauth2/token` | Access token for every call; also checks an owner's keys when they connect PayPal | [`client.ts`](src/lib/paypal/client.ts), [`settings.ts`](src/lib/paypal/settings.ts) |
| `POST /v2/checkout/orders` | Create an order at the listed price (`/pricing`, chat checkout, `paypal:smoke`) | [`checkout.ts`](src/lib/paypal/checkout.ts), [`scripts/paypal-smoke.ts`](scripts/paypal-smoke.ts) |
| `GET /v2/checkout/orders/{id}` | Read an order: payer email for the order ID + email check, and the capture state when it is unclear | [`visitor-tools.ts`](src/lib/paypal/visitor-tools.ts), [`capture.ts`](src/lib/paypal/capture.ts) |
| `POST /v2/checkout/orders/{id}/capture` | Capture after the buyer approves (return URL or `CHECKOUT.ORDER.APPROVED` webhook), with `PayPal-Request-Id` | [`capture.ts`](src/lib/paypal/capture.ts), [return route](src/app/api/paypal/return/%5BbotId%5D/route.ts) |
| `GET /v2/payments/captures/{id}` | Facts before a refund (status, amount, currency, date), re-check before an approved refund is sent, payment status in chat, webhook events | [`refund.ts`](src/lib/paypal/refund.ts), [`webhook.ts`](src/lib/paypal/webhook.ts), [`visitor-tools.ts`](src/lib/paypal/visitor-tools.ts) |
| `POST /v2/payments/captures/{id}/refund` | The refund itself, always with an explicit amount and `PayPal-Request-Id` | [`refund.ts`](src/lib/paypal/refund.ts) |
| `GET /v2/payments/refunds/{id}` | Settle a refund whose result was unclear (for example a timeout), and update the order's refunded total | [`refund.ts`](src/lib/paypal/refund.ts), [`capture.ts`](src/lib/paypal/capture.ts) |
| `GET /v1/customer/disputes?disputed_transaction_id=` | Guardrail check: a payment with an open dispute is never refunded automatically | [`refund.ts`](src/lib/paypal/refund.ts) |
| `POST /v1/notifications/webhooks` | Register the bot's webhook when the owner connects PayPal (or from the CLI) | [`settings.ts`](src/lib/paypal/settings.ts), [`scripts/paypal-register-webhook.ts`](scripts/paypal-register-webhook.ts) |
| `GET /v1/notifications/webhooks` | Find an existing webhook for the same URL instead of creating a duplicate | [`settings.ts`](src/lib/paypal/settings.ts), [`scripts/paypal-register-webhook.ts`](scripts/paypal-register-webhook.ts) |
| `PATCH /v1/notifications/webhooks/{id}` | Update the event list of an existing webhook | [`settings.ts`](src/lib/paypal/settings.ts), [`scripts/paypal-register-webhook.ts`](scripts/paypal-register-webhook.ts) |
| `DELETE /v1/notifications/webhooks/{id}` | Remove the webhook when the owner disconnects PayPal | [`settings.ts`](src/lib/paypal/settings.ts), [bot PayPal route](src/app/api/bots/%5Bid%5D/paypal/route.ts) |
| `GET /v1/notifications/certs/…` (from the `paypal-cert-url` header) | Webhook signature check, done locally (CRC32 + SHA256withRSA) instead of calling `verify-webhook-signature`; only PayPal cert hosts are accepted | [`webhook.ts`](src/lib/paypal/webhook.ts), [webhook route](src/app/api/paypal/webhook/%5BbotId%5D/route.ts) |

Webhook events subscribed: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` / `DENIED` / `DECLINED` / `REFUNDED` / `REVERSED`, and `CUSTOMER.DISPUTE.CREATED` / `UPDATED` / `RESOLVED` (stored only).

## Stack

Next.js 16 (App Router) · Vercel AI SDK 7 · Claude (Anthropic) by default, Gemini or OpenAI selectable · Supabase (Postgres) · NextAuth (Google sign-in) · PayPal REST API (sandbox) · PayPal Agent Toolkit (read-only, sandbox) · AG Grid Community · AG Studio · next-intl

## Run it locally

```bash
git clone https://github.com/wineny/feedloop.git
cd feedloop
npm install
cp .env.example .env.local   # fill in the keys — every variable is documented in the file

# Database: a fresh Supabase project, one file.
psql "$POSTGRES_URL_NON_POOLING" -v ON_ERROR_STOP=1 -f supabase/schema.sql
#   (or paste supabase/schema.sql into the Supabase SQL editor)
# Optional: the demo bot whose widget runs on the pricing page, plus its three products.
npm run db:seed-demo -- --owner you@example.com --url http://localhost:3000

npm run dev                  # http://localhost:3000
```

- **Schema.** `supabase/schema.sql` is generated from `supabase/migrations/` by `npm run db:schema`. Apply the one file, not the folder (three early migrations have no date prefix and sort in the wrong order).
- **PayPal.** Create a sandbox app at developer.paypal.com and put its client id / secret in `.env.local`. `npm run paypal:smoke` proves the credentials by creating a USD 1.00 sandbox order (nothing is captured). Then open `/pricing` and buy a plan with a sandbox **personal** (buyer) account from the developer dashboard's Sandbox accounts page — log in on the PayPal page rather than paying as a guest card.
- **Webhooks.** `npm run paypal:webhook -- --url https://<your-domain>` registers `/api/paypal/webhook/<demoBotId>` and prints the id for `PAYPAL_WEBHOOK_ID` (PayPal only delivers to https). Bots connected from the PayPal settings tab register their own webhook.
- **Reset the demo bot (maintainers).** `npm run db:reset-demo` is a dry run: it prints how many rows would be deleted. `npm run db:reset-demo -- --yes` deletes the demo bot's conversations, insights, groups, PayPal orders, refund/approval rows and webhook events. It keeps the bot's settings, products and approvers.

## Tests

```bash
npm test             # vitest — unit, route and guardrail-shape tests
npm run db:dry-run   # applies schema.sql + the 22-case refund guardrail scenario to a throw-away local PostgreSQL (needs a postgres binary, e.g. brew install postgresql@15)
```

## License

MIT — see [LICENSE](LICENSE).
