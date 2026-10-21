-- 2026-10-21 i18n 4/8 — conversations.locale: the language the visitor used in the widget ('en' | 'ko').
--
-- Why: the "your problem is fixed" mail and chat card go to the visitor in the language they
-- wrote in (src/lib/auto-dev/loop-closed.ts), and a group of several conversations can mix languages.
-- Before this column the language was guessed from the Korean letters in the group title.
--
-- Safe to apply at any time, including while the old code is serving: the column is nullable,
-- has no default, and no existing code reads or writes it. NULL means "unknown" (every row that
-- exists today, and Kakao / Channel Talk conversations): the new code then falls back to the
-- old guess (Korean letters in the title).
--
-- Apply order:  this file (together with 20261021_10, i.e. BEFORE the new code is deployed)
--   ->  deploy  ->  20261021_11 (data).
-- It must come before the deploy, not after: the new widget routes write `locale` in the same upsert
-- as the conversation row, and PostgREST rejects an unknown column.
--
-- The widget routes (messages / contact / escalate) overwrite the value on every request,
-- so it follows the visitor's latest language (a visitor who switches the page language gets the
-- notification in the new language). Kakao / Channel Talk upserts do not send the field and leave it alone.
--
-- ROLLBACK (old code never uses it, so this is only needed to clean up):
--   ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_locale_check;
--   ALTER TABLE conversations DROP COLUMN IF EXISTS locale;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS locale text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_locale_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_locale_check CHECK (locale IS NULL OR locale IN ('en', 'ko'));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
