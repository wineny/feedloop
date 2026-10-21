import fs from 'node:fs';
import path from 'node:path';
import React, { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

// children 을 props 로 넘기면 lint(react/no-children-prop), createElement 인자로 넘기면 타입이 막아서 좁힌 타입으로 한 번 감싼다.
const Provider = NextIntlClientProvider as unknown as React.ComponentType<{
  locale: string;
  messages: unknown;
  children?: React.ReactNode;
}>;

const MESSAGES_DIR = path.resolve(__dirname, '../../messages');

/** `messages/<locale>/*.json` 을 `{ 파일이름: 내용 }` 하나로 합친다 — src/i18n/request.ts 와 같은 모양. */
export function loadMessages(locale: 'en' | 'ko'): Record<string, unknown> {
  const dir = path.join(MESSAGES_DIR, locale);
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => [f.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]),
  );
}

/** 실제 사전을 실은 `NextIntlClientProvider` 안에서 렌더한다. 문구 단언은 기본 영어(en)로 쓴다. */
export function renderWithIntl(ui: ReactElement, locale: 'en' | 'ko' = 'en'): string {
  return renderToStaticMarkup(
    React.createElement(Provider, { locale, messages: loadMessages(locale) }, ui),
  );
}
