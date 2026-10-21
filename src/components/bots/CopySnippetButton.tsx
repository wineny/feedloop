'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

interface CopySnippetButtonProps {
  text: string;
}

/** 텍스트 링크 모양의 복사 버튼 — 섹션 제목 줄 우측에 놓는다 */
export function CopySnippetButton({ text }: CopySnippetButtonProps) {
  const t = useTranslations('common');
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-sm font-semibold text-brand-strong hover:underline"
    >
      {copied ? t('copied') : t('copy')}
    </button>
  );
}
