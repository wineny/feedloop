# Feedloop

**An AI support agent that doesn't just answer — it settles the money.**

Feedloop is a drop-in chat widget for small online businesses. Customers type what they want; the AI classifies it, answers from the owner's knowledge base, and — with PayPal — actually settles payment issues: verifies the payment, refunds within the owner's limits, sells from the price table mid-conversation, and when the same payment problem comes from several customers it opens a pull request that fixes the cause. Anything beyond the limits becomes a one-tap approval in the inbox.

🏆 Grand Prize, Wanted AI Championship 2026 (1st of 1,389 projects) — the Korean production version runs at https://ai-feedloop.vercel.app

> **Status (Oct 18, 2026):** this repository is the open-source, English-first edition being built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). PayPal integration is in progress. See [What's being added](#whats-being-added-during-the-hackathon).

## What it does today

- **One-line install.** Paste a script tag; the widget appears on your site.
- **Understands intent.** Every message is classified (bug, question, feature request, complaint …) and grouped with similar ones.
- **Answers from your knowledge.** The bot replies only from what you've written; anything it doesn't know is handed to a human.
- **Closes the loop.** When a report is fixed, the person who sent it gets notified. If a GitHub repo is connected, Feedloop opens a pull request with a proposed fix — a human decides whether to merge.
- **Owner dashboard.** Inbox, grouping, knowledge editing, bot settings.

## What's being added during the hackathon

| # | Feature | PayPal capability | Status |
|---|---|---|---|
| 1 | Payment issues handled in chat — order id + email check → lookup → refund inside the owner's limits | Orders, Captures, Refunds | schema + guardrail RPC done |
| 2 | Guardrail + approval card — anything outside the limits waits in the inbox for a one-tap decision | — | schema done |
| 3 | Checkout mid-conversation — pick from the price table → PayPal link → capture | Orders (create / capture), Webhooks | `/pricing` checkout + capture + webhook done; chat tool next |
| 4 | Group → root-cause PR — the same payment problem from several customers becomes one fix PR | — | reuses the existing pipeline |
| 5 | Money ledger + four numbers in the owner dashboard (AG Grid Community) | Refunds, Orders, Disputes | planned |
| 6 | Disputes: webhook → inbox card → accept with approval (stretch) | Disputes, Webhooks | planned |

Guardrail: the agent moves money on its own only inside limits the owner sets — by default refunds up to $20, within 14 days of purchase, one per customer per 30 days, $100 per day — and only after the server has verified the payment against PayPal. The decision and the write-ahead row are one Postgres function (`payment_action_open_refund`), so two concurrent "refund me" messages can never both execute. Money-moving calls go through our own REST client with `PayPal-Request-Id`, never through the LLM toolkit.

## Stack

Next.js 16 (App Router) · Vercel AI SDK 7 · Claude (Anthropic) · Supabase (Postgres) · NextAuth · PayPal Agent Toolkit (sandbox)

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

`supabase/schema.sql` is generated from `supabase/migrations/` by `npm run db:schema` — apply the one file, not the folder (three early migrations have no date prefix and sort in the wrong order). PayPal: create a sandbox app at developer.paypal.com and put its client id / secret in `.env.local`; `npm run paypal:smoke` proves the credentials by creating a USD 1.00 sandbox order (nothing is captured). Then open `/pricing` and buy a plan with a sandbox **personal** (buyer) account from the dashboard's Sandbox accounts page — log in on the PayPal page rather than paying as a guest card. For webhooks, `npm run paypal:webhook -- --url https://<your-domain>` registers `/api/paypal/webhook/<demoBotId>` and prints the id for `PAYPAL_WEBHOOK_ID` (PayPal only delivers to https). Judge test accounts will be added here before submission.

## Tests

```bash
npm test             # vitest — unit, route and guardrail-shape tests
npm run db:dry-run   # applies schema.sql + the 12-case refund guardrail scenario to a throw-away local PostgreSQL (needs a postgres binary, e.g. brew install postgresql@15)
```

## License

MIT — see [LICENSE](LICENSE).
