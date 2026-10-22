/** 문구와 무관하게 분기하려고 코드값을 싣는 오류. 메시지는 로그·화면용이다. */
export type AutoDevErrorCode = 'no_files' | 'missing_target';

export class AutoDevError extends Error {
  constructor(readonly code: AutoDevErrorCode, message: string) {
    super(message);
    this.name = 'AutoDevError';
  }
}

export function autoDevErrorCode(error: unknown): AutoDevErrorCode | null {
  return error instanceof AutoDevError ? error.code : null;
}
