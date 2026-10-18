import { describe, it, expect } from 'vitest';
import { validateRegistrationInput, GITHUB_REPO_URL_RE } from '@/lib/bot/registration';

describe('validateRegistrationInput', () => {
  it('정상 입력을 정규화한다 (빈 값 → null, 끝 슬래시 제거, pr_mode 기본 approve)', () => {
    const r = validateRegistrationInput({
      service_name: '  널널투어 ',
      service_description: '',
      service_url: 'https://nullnul-tour-demo.vercel.app',
      github_repo_url: 'https://github.com/wineny/nullnul-tour-demo/',
    });
    expect(r).toEqual({
      ok: true,
      values: {
        service_name: '널널투어',
        service_description: null,
        service_url: 'https://nullnul-tour-demo.vercel.app',
        github_repo_url: 'https://github.com/wineny/nullnul-tour-demo',
        pr_mode: 'approve',
      },
    });
  });

  it('pr_mode 는 auto 만 인정하고 나머지는 approve 로 접는다', () => {
    expect(validateRegistrationInput({ service_name: 'ab', pr_mode: 'auto' })).toMatchObject({ ok: true, values: { pr_mode: 'auto' } });
    expect(validateRegistrationInput({ service_name: 'ab', pr_mode: 'yolo' })).toMatchObject({ ok: true, values: { pr_mode: 'approve' } });
  });

  it('서비스 이름이 없거나 짧거나 길면 거절한다', () => {
    expect(validateRegistrationInput({})).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ service_name: 'a' })).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ service_name: 'x'.repeat(61) })).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ service_name: 123 })).toMatchObject({ ok: false });
  });

  it('GitHub 레포 URL 은 앵커된 형태만 받는다 (confused deputy 방지)', () => {
    const bad = [
      'https://evil.example/?x=github.com/wineny/private',
      'https://github.com/wineny',
      'https://github.com/wineny/repo/tree/main',
      'http://github.com/wineny/repo',
      'github.com/wineny/repo',
    ];
    for (const url of bad) {
      expect(GITHUB_REPO_URL_RE.test(url), url).toBe(false);
      expect(validateRegistrationInput({ service_name: 'ab', github_repo_url: url })).toMatchObject({ ok: false });
    }
    expect(validateRegistrationInput({ service_name: 'ab', github_repo_url: 'https://github.com/wineny/nullnul-tour-demo' })).toMatchObject({ ok: true });
  });

  it('서비스 URL 은 http(s) 만 받는다', () => {
    expect(validateRegistrationInput({ service_name: 'ab', service_url: 'javascript:alert(1)' })).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ service_name: 'ab', service_url: 'not a url' })).toMatchObject({ ok: false });
    expect(validateRegistrationInput({ service_name: 'ab', service_url: 'http://localhost:3000' })).toMatchObject({ ok: true });
  });

  it('배열·null 바디는 거절한다', () => {
    expect(validateRegistrationInput(null)).toMatchObject({ ok: false });
    expect(validateRegistrationInput([])).toMatchObject({ ok: false });
  });
});
