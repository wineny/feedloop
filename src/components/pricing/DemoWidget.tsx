import Script from 'next/script';

/**
 * The demo bot's support widget on the PayPal demo shop pages (design v2 §1: the shop's support
 * is Feedloop's own widget). The `?bot=` query keeps next/script from treating this as the
 * already-loaded self widget (`SelfWidget`, same /widget.js) after a client-side navigation.
 */
interface DemoWidgetProps {
  botId: string;
}

export function DemoWidget({ botId }: DemoWidgetProps) {
  return (
    <Script
      id={`feedloop-widget-${botId}`}
      src={`/widget.js?bot=${encodeURIComponent(botId)}`}
      data-feedloop={botId}
      strategy="afterInteractive"
    />
  );
}
