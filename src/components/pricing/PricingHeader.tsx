import Link from 'next/link';
import { LogoMark } from '@/components/landing/Logo';

/** English header for the PayPal demo shop. The global Korean navigation hides on these paths. */
export function PricingHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <Link href="/" className="flex min-h-11 items-center gap-2 text-xl font-extrabold tracking-[-0.03em] text-foreground">
        <LogoMark size={22} className="text-[#F2645C]" />
        Feedloop
      </Link>
      <span className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
        PayPal sandbox · no real money moves
      </span>
    </header>
  );
}
