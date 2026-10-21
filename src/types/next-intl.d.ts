// next-intl 타입: 영어 사전을 기준 타입으로 삼아 `t('없는.키')` 를 tsc 가 잡게 한다.
// 사전 파일을 새로 만들면 여기에도 넣는다(`src/i18n/namespaces.ts` 의 MESSAGE_NAMESPACES 와 같은 목록).
import type common from '../../messages/en/common.json';
import type meta from '../../messages/en/meta.json';
import type notFound from '../../messages/en/notFound.json';
import type landing from '../../messages/en/landing.json';
import type nav from '../../messages/en/nav.json';
import type auth from '../../messages/en/auth.json';
import type pricing from '../../messages/en/pricing.json';
import type inbox from '../../messages/en/inbox.json';
import type picked from '../../messages/en/picked.json';
import type bots from '../../messages/en/bots.json';
import type connect from '../../messages/en/connect.json';
import type llm from '../../messages/en/llm.json';
import type github from '../../messages/en/github.json';
import type dashboard from '../../messages/en/dashboard.json';
import type demo from '../../messages/en/demo.json';

declare module 'next-intl' {
  interface AppConfig {
    Messages: {
      common: typeof common;
      meta: typeof meta;
      notFound: typeof notFound;
      landing: typeof landing;
      nav: typeof nav;
      auth: typeof auth;
      pricing: typeof pricing;
      inbox: typeof inbox;
      picked: typeof picked;
      bots: typeof bots;
      connect: typeof connect;
      llm: typeof llm;
      github: typeof github;
      dashboard: typeof dashboard;
      demo: typeof demo;
    };
  }
}
