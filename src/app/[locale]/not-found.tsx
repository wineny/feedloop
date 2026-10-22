import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';

// notFound() 를 부른 경로(`/nope` 는 아래 [...rest] 가 부른다)가 이 화면을 받는다.
export default function NotFoundPage() {
  const t = useTranslations('notFound');
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{t('body')}</p>
      <Button asChild>
        <Link href="/">{t('home')}</Link>
      </Button>
    </div>
  );
}
