import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class BadCommand extends Error {}
export class UnsafePath extends Error {}
export class UpstreamError extends Error {}

const MENTION = '@grok-imagine';
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const FORBIDDEN_PREFIXES = ['.git/', '.github/workflows/', 'node_modules/'];
const SLUG_MAX = 40;
const PROMPT_PREVIEW_MAX = 80;

export function parseCommand(body) {
  if (typeof body !== 'string') throw new BadCommand('comment body missing');
  const trimmed = body.trim();
  if (!trimmed.startsWith(MENTION)) throw new BadCommand('not a grok-imagine command');

  let rest = trimmed.slice(MENTION.length).trim();
  let savePath = null;

  if (rest.startsWith('--save ')) {
    const afterFlag = rest.slice('--save '.length).trimStart();
    const match = afterFlag.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) throw new BadCommand('--save needs a path and a prompt');
    savePath = match[1];
    rest = match[2].trim();
  }

  if (!rest) throw new BadCommand('prompt is empty');
  return { prompt: rest, savePath };
}

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export function slugify(text, max = SLUG_MAX) {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'image').slice(0, max).replace(/-+$/, '') || 'image';
}

export function resolveOutputPath({ savePath, prompt, sha, repoRoot }) {
  const root = path.resolve(repoRoot);
  let rel;

  if (savePath) {
    if (path.isAbsolute(savePath)) throw new UnsafePath('absolute paths are not allowed');
    if (savePath.split(/[\\/]+/).includes('..')) throw new UnsafePath('"..": path traversal not allowed');
    rel = savePath.replace(/\\/g, '/');
  } else {
    rel = `public/generated/${slugify(prompt)}-${String(sha).slice(0, 7)}.png`;
  }

  for (const bad of FORBIDDEN_PREFIXES) {
    if (rel === bad.slice(0, -1) || rel.startsWith(bad)) {
      throw new UnsafePath(`writes under ${bad} are not allowed`);
    }
  }

  const ext = path.extname(rel).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new UnsafePath(`extension ${ext || '(none)'} is not an allowed image type`);
  }

  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new UnsafePath('path escapes repo root');
  }
  return { abs, rel };
}

export async function generateImage({ prompt, apiKey, model, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json' }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UpstreamError(`xAI ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new UpstreamError('xAI returned no image payload');
  return Buffer.from(b64, 'base64');
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

export function writeAndCommit({ absPath, repoRoot, buffer, branch, prompt }) {
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, buffer);

  const env = { cwd: repoRoot };
  sh('git', ['config', 'user.name', 'github-actions[bot]'], env.cwd);
  sh('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], env.cwd);
  sh('git', ['add', '--', absPath], env.cwd);

  const status = sh('git', ['status', '--porcelain', '--', absPath], env.cwd);
  if (!status) {
    return { committed: false, sha: null };
  }

  const preview = prompt.length > PROMPT_PREVIEW_MAX
    ? `${prompt.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
    : prompt;
  sh('git', ['commit', '-m', `bot: grok-imagine "${preview.replace(/"/g, '\\"')}"`], env.cwd);
  sh('git', ['push', 'origin', `HEAD:${branch}`], env.cwd);
  const sha = sh('git', ['rev-parse', 'HEAD'], env.cwd);
  return { committed: true, sha };
}

function gh(args, input) {
  return execFileSync('gh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    input: input ?? undefined,
  }).toString();
}

export function reactToComment({ repo, commentId, content }) {
  gh([
    'api',
    '--method', 'POST',
    `/repos/${repo}/issues/comments/${commentId}/reactions`,
    '-f', `content=${content}`,
  ]);
}

export function deleteReaction({ repo, commentId, reactionId }) {
  gh([
    'api',
    '--method', 'DELETE',
    `/repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`,
  ]);
}

export function findOwnReaction({ repo, commentId, content, actor }) {
  const out = gh([
    'api',
    `/repos/${repo}/issues/comments/${commentId}/reactions`,
  ]);
  const list = JSON.parse(out);
  const hit = list.find((r) => r.content === content && r.user?.login === actor);
  return hit ? hit.id : null;
}

export function postComment({ repo, prNumber, body }) {
  gh(
    ['api', '--method', 'POST', `/repos/${repo}/issues/${prNumber}/comments`, '--input', '-'],
    JSON.stringify({ body }),
  );
}

export async function run({ event, env, repoRoot, fetchImpl }) {
  const repo = env.GITHUB_REPOSITORY;
  const actor = 'github-actions[bot]';
  const comment = event.comment;
  const issue = event.issue;
  const commentId = comment.id;
  const prNumber = issue.number;
  const branch = env.PR_HEAD_REF;
  const sha = env.PR_HEAD_SHA;
  const model = env.GROK_IMAGE_MODEL || 'grok-2-image-1212';

  reactToComment({ repo, commentId, content: 'eyes' });

  const finishOk = (body) => {
    const eyesId = findOwnReaction({ repo, commentId, content: 'eyes', actor });
    if (eyesId) deleteReaction({ repo, commentId, reactionId: eyesId });
    reactToComment({ repo, commentId, content: '+1' });
    postComment({ repo, prNumber, body });
  };

  const finishErr = (message) => {
    const eyesId = findOwnReaction({ repo, commentId, content: 'eyes', actor });
    if (eyesId) deleteReaction({ repo, commentId, reactionId: eyesId });
    reactToComment({ repo, commentId, content: '-1' });
    postComment({ repo, prNumber, body: `grok-imagine failed: ${message}` });
  };

  try {
    if (issue.pull_request?.head?.repo?.fork) {
      finishErr('fork PRs are not supported');
      return;
    }

    const { prompt, savePath } = parseCommand(comment.body);
    const { abs, rel } = resolveOutputPath({ savePath, prompt, sha, repoRoot });

    const apiKey = env.XAI_API_KEY;
    if (!apiKey) throw new UpstreamError('XAI_API_KEY is not set');

    const buffer = await generateImage({ prompt, apiKey, model, fetchImpl });
    const { committed } = writeAndCommit({ absPath: abs, repoRoot, buffer, branch, prompt });

    if (!committed) {
      finishErr(`nothing to commit at \`${rel}\` (file was identical)`);
      return;
    }

    const promptPreview = prompt.length > PROMPT_PREVIEW_MAX
      ? `${prompt.slice(0, PROMPT_PREVIEW_MAX - 1)}…`
      : prompt;
    const imageUrl = `https://github.com/${repo}/raw/${branch}/${rel}`;
    finishOk(
      `Generated \`${rel}\` for prompt _"${promptPreview}"_:\n\n![grok-imagine](${imageUrl})`,
    );
  } catch (err) {
    if (err instanceof BadCommand) {
      finishErr(`${err.message}. Usage: \`@grok-imagine [--save <path>] <prompt>\``);
    } else if (err instanceof UnsafePath) {
      finishErr(`save path rejected: ${err.message}`);
    } else if (err instanceof UpstreamError) {
      finishErr(err.message);
    } else {
      finishErr(`unexpected: ${err.message || err}`);
    }
  }
}
