import { notFound } from 'next/navigation';

// 모르는 경로를 notFound() 로 보내 [locale]/not-found.tsx 가 받게 한다(next-intl 문서: Catching unknown routes).
export default function CatchAllPage() {
  notFound();
}
