import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { LandingNav } from '@/components/landing/LandingNav';
import { HeroSection } from '@/components/landing/HeroSection';
import { ProblemSection } from '@/components/landing/ProblemSection';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { DemoSection } from '@/components/landing/DemoSection';
import { PlansSection } from '@/components/landing/Plans';
import { FaqSection } from '@/components/landing/FaqSection';
import { FinalCTA } from '@/components/landing/FinalCTA';
import { LandingFooter } from '@/components/landing/LandingFooter';
import { PageMessages } from '@/i18n/PageMessages';

export async function generateMetadata({ params }: PageProps<'/[locale]'>): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: t('title'),
    description: t('description'),
    openGraph: { title: t('title'), description: t('description'), images: ['/og.png'] },
  };
}

export default function HomePage() {
  // 루트 레이아웃 main(max-w-[1120px] px-6 py-7)을 풀블리드로 벗어난다.
  // ⚠️ `-my-7` 은 그 `py-7` 과 «정확히» 같아야 한다 — 어긋나면 코랄 히어로 위에
  // 그만큼 흰 띠가 남고, sticky 나브가 붙는 순간 그 폭만큼 튄다(예전엔 4px 튀었다).
  return (
    <PageMessages page="landing">
    <div
      className="landing -my-7 bg-[var(--bg)] text-[var(--ink)]"
      style={{
        marginLeft: 'calc(-50vw + 50%)',
        marginRight: 'calc(-50vw + 50%)',
        width: '100vw',
        fontFamily: 'var(--font)',
      }}
    >
      {/* 나브는 히어로 «밖»에 있어야 sticky 가 산다 — 히어로 section 이 overflow-hidden 이다.
          자리를 차지하지 않으므로(h-0) 코랄 지면은 그대로 페이지 맨 위에서 시작한다 */}
      <LandingNav />
      <HeroSection />
      <ProblemSection />
      <HowItWorks />
      <DemoSection />
      <PlansSection />
      <FaqSection />
      <FinalCTA />
      <LandingFooter />
    </div>
    </PageMessages>
  );
}
