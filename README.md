# Feedloop

**An AI support agent that doesn't just answer — it settles the money.**

Feedloop is a drop-in chat widget for small online businesses. Customers type what they want; the AI classifies it, answers from the owner's knowledge base, and — with PayPal — actually resolves payment issues: refunds within the owner's limits, subscription changes, checkout links mid-conversation, and dispute responses the owner approves with one tap.

🏆 Grand Prize, Wanted AI Championship 2026 (1st of 1,389 projects) — the Korean production version runs at https://ai-feedloop.vercel.app

> **Status (Oct 18, 2026):** this repository is the open-source, English-first edition being built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). PayPal integration is in progress. See [What's being added](#whats-being-added-during-the-hackathon).

## What it does today

- **One-line install.** Paste a script tag; the widget appears on your site.
- **Understands intent.** Every message is classified (bug, question, feature request, complaint …) and grouped with similar ones.
- **Answers from your knowledge.** The bot replies only from what you've written; anything it doesn't know is handed to a human.
- **Closes the loop.** When a report is fixed, the person who sent it gets notified. If a GitHub repo is connected, Feedloop opens a pull request with a proposed fix — a human decides whether to merge.
- **Owner dashboard.** Inbox, grouping, knowledge editing, bot settings.

## What's being added during the hackathon

| # | Feature | PayPal capability |
|---|---|---|
| 1 | Payment issues handled in chat — "I was charged twice", "refund me" | Transactions, Orders, Refunds |
| 2 | Checkout mid-conversation — "I'll take it" → order or invoice link in the thread | Orders, Invoicing |
| 3 | Subscription questions — change plan, cancel | Subscriptions |
| 4 | Payments overview in the owner dashboard | Transactions, Merchant insights |
| 5 | Disputes land in the inbox with a drafted response the owner approves | Disputes, Webhooks |

Guardrail: the agent acts on its own only inside limits the owner sets (for example, refunds up to $20 within 14 days). Anything beyond that becomes a one-tap approval in the inbox.

## Stack

Next.js 16 (App Router) · Vercel AI SDK 7 · Claude (Anthropic) · Supabase (Postgres) · NextAuth · PayPal Agent Toolkit (sandbox)

## Run it locally

```bash
git clone https://github.com/wineny/feedloop.git
cd feedloop
npm install
cp .env.example .env.local   # fill in the keys (see below)
npm run dev                  # http://localhost:3000
```

Setup instructions for Supabase, PayPal sandbox credentials, and a judge test account will be completed before submission.

## Tests

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
