import Script from 'next/script';
import { useLocale } from 'next-intl';

/**
 * The demo bot's support widget on the PayPal demo shop pages (design v2 §1: the shop's support
 * is Feedloop's own widget). The `?bot=` query keeps next/script from treating this as the
 * already-loaded self widget (`SelfWidget`, same /widget.js) after a client-side navigation.
 * `data-locale` pins the widget to the page language — otherwise it follows the browser's
 * language, and a Korean browser shows a Korean widget on /en pages.
 */
interface DemoWidgetProps {
  botId: string;
}

export function DemoWidget({ botId }: DemoWidgetProps) {
  const locale = useLocale();
  return (
    <Script
      id={`feedloop-widget-${botId}`}
      src={`/widget.js?bot=${encodeURIComponent(botId)}`}
      data-feedloop={botId}
      data-locale={locale}
      strategy="afterInteractive"
    />
  );
}
