// GitHub 레포 URL → owner/repo. 의존성 0.
//
// ai-engine.ts 에 있던 것을 옮겼다 — 토큰 검증(lib/github/token.ts)이 이걸 쓰는데 ai-engine 은 토큰
// 해석(github-auth.ts)을 쓰므로 그대로 두면 import 가 돈다. ai-engine 은 같은 이름으로 다시 내보낸다.

/** 앵커하지 않으면 `https://evil.example/?x=github.com/a/b` 도 통과해 토큰이 남의 레포로 향한다. */
export function parseRepoInfo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl
    .trim()
    .replace(/\.git$/, '')
    .match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/?$/);
  if (!match) throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}
