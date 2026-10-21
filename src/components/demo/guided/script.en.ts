import type { ScriptCopy } from './script';

/**
 * English script. Not a translation of the Korean one: the same incident (a partner-shop coupon
 * will not download) is retold for an English-speaking reviewer. Every string that points at the
 * screen copies (`public/demo/<screen>/index.html`) must match that page character for character,
 * or the walkthrough cannot find the spot to ring (`__tests__/demo-sandbox.test.ts` checks it).
 */
export const copy: ScriptCopy = {
  hello: 'Hi! This is Nulnul Tour. If a coupon or a booking gave you trouble, tell us here.',
  report: "The coupon download isn't working",
  // The bot does not guess at causes; it hands the report to the team (`src/lib/bot/holding.ts`).
  reply:
    "Sorry about that. I've logged this as a problem with “Get coupon.” I won't guess at the cause, so I'm passing it to the team as is. I'll tell you in this chat once it's fixed.",
  fixed: 'We fixed the “Get coupon” problem you reported. Partner shop coupons now download right away.',
  groupTitle: "Tapping “Get coupon” doesn't issue a coupon",
  similar: ["The coupon download isn't working", 'Tapping Get coupon does nothing', "Partner shop coupons won't issue"],
  couponButton: 'Get coupon',
  prLines: ['View PR #128 on GitHub', 'PR #128 · 47s · 2 files'],
  recipients: ['Emily Carter', 'Visitor #b7c4'],
  delivered: 'Delivered',
  mailSubject: '[Nulnul Tour] We fixed the problem you reported',
  urls: {
    map: 'nulnul.vercel.app/nationwide',
    inbox: 'ai-feedloop.vercel.app/inbox',
    groups: 'ai-feedloop.vercel.app/dashboard',
    pr: 'ai-feedloop.vercel.app/monitor',
    mail: 'Inbox of emily@example.com',
  },
  steps: {
    open: { title: 'The chat button, bottom right', short: 'Open the chat', hint: 'Tap this button' },
    write: { title: 'Say what went wrong, in your own words', short: 'Leave a quick note', hint: 'Tap the input' },
    tool: { title: "You don't have to describe it", short: 'Turn on Pick on screen', hint: 'Tap here' },
    point: { title: 'Point at the exact problem', short: 'Pick the problem spot', hint: 'Pick the button that fails' },
    arrive: {
      title: "Same moment, in the team's inbox",
      short: 'It arrives and gets triaged',
      hint: '',
      say: 'Feedback from a visitor',
      label: 'Check whether anyone else said the same',
    },
    similar: {
      title: 'Someone else said the same thing',
      short: 'Find similar reports',
      hint: 'These three are the same problem',
      label: 'See how the three get grouped',
    },
    group: {
      title: 'A group is harder to ignore',
      short: 'Bundle them into one group',
      hint: '',
      say: 'They become one piece of feedback',
      label: 'See this group turn into code',
    },
    pr: {
      title: 'The AI drafts the fix too',
      short: 'AI writes the fix PR',
      hint: '',
      say: 'The AI drafts the fix and asks for approval',
      label: 'See what a person has to do',
    },
    merge: {
      title: 'One job for a person: decide to ship',
      short: 'A person decides to ship',
      hint: '',
      say: 'Everyone who reported it is notified automatically',
      label: 'Ship it and tell the people who reported it',
    },
    returned: {
      title: 'The answer comes back to the chat',
      short: '“Fixed” appears in the chat',
      hint: 'The fix reaches them in the chat too',
    },
    mail: {
      title: 'And once more by email',
      short: 'It reaches their inbox too',
      hint: '',
      say: 'Also sent by email',
      label: "That's one full loop",
    },
  },
};
