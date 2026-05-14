# Grok Imagine PR Bot — Design

**Date:** 2026-05-10
**Author:** Art (with Claude)
**Status:** Approved, ready for implementation plan

## Overview

A GitHub Actions–powered bot that generates AI images via xAI's Grok image API in response to PR comments. The owner mentions `@grok-imagine` in a PR comment with a prompt; the bot generates a PNG, commits it to the PR's head branch, and replies with the image inline.

This spec covers the **image-generation bot** only. A separate "screenshot the PR's actual changes" bot was discussed and deferred — it will get its own spec when scheduled.

## Trigger & invocation

Comments on **pull requests** (not standalone issues) that:

- Start with the literal `@grok-imagine ` (mention + space), and
- Are authored by the repository owner (`github.repository_owner`).

Anything else is silently ignored.

### Syntax

```
@grok-imagine <prompt>
@grok-imagine --save <path> <prompt>
```

- `<prompt>` — free text passed verbatim to xAI.
- `--save <path>` — optional. Repo-relative path where the generated PNG should land. If omitted, the bot writes to `public/generated/<slug>-<shortsha>.png` where `<slug>` is the prompt slugified to ≤40 chars and `<shortsha>` is the first 7 chars of the head commit SHA.

### Examples

```
@grok-imagine a glowing CRT in vaporwave colors
@grok-imagine --save public/og.png a moody portrait of a terminal
@grok-imagine --save content/building/snake/cover.png a snake game in low-poly neon
```

## Architecture

A single workflow at `.github/workflows/grok-imagine.yml` triggered by `issue_comment` (`types: [created]`) on PRs. The workflow:

1. **Filters.** `if:` gate requires the comment to be on a PR (`github.event.issue.pull_request != null`), to start with `@grok-imagine `, and to be authored by the repo owner.
2. **Reacts** to the comment with 👀 via `octokit.reactions.createForIssueComment`.
3. **Checks out** the PR's head branch with write-capable token.
4. **Runs** the Node script `.github/scripts/grok-imagine.mjs`, passing the comment body, repo info, and `XAI_API_KEY`.
5. **Replies** in the PR thread with a markdown image embed pointing at the committed file (relative path → renders on GitHub).
6. **Updates the reaction** on completion: deletes the 👀 reaction and adds ✅ on success, or deletes 👀, adds ❌, and posts an error comment on failure.

No external service, no webhooks. Pure GitHub Actions on `ubuntu-latest`.

### Why a separate `.mjs` script and not inline `run:` shell

- Comment parsing + path sanitization is non-trivial and should be testable.
- Workflow file stays small and readable — pure plumbing.

## File layout

```
.github/workflows/grok-imagine.yml          (new)
.github/scripts/grok-imagine.mjs            (new)
.github/scripts/grok-imagine.test.mjs       (new — minimal coverage)
docs/superpowers/specs/2026-05-10-grok-imagine-bot-design.md  (this spec)
public/generated/                            (created on first invocation; .gitkeep optional)
```

## Components

### `parseCommand(body: string) → { prompt, savePath | null }`

- Strips the leading `@grok-imagine ` mention.
- Detects optional `--save <path>` flag at the start of the remainder.
- Returns `{ prompt: string, savePath: string | null }`.
- Throws `BadCommand` if the prompt is empty after stripping.

### `resolveOutputPath(savePath: string | null, prompt: string, sha: string, repoRoot: string) → string`

Returns an absolute path under `repoRoot`. Rejects (throws `UnsafePath`):

- Absolute paths (`C:\...`, `/etc/...`).
- Anything containing `..` after normalization.
- Anything that escapes `repoRoot` after `path.resolve`.
- Paths inside `.git/`, `.github/workflows/`, or `node_modules/`.
- Non-image extensions (only `.png`, `.jpg`, `.jpeg`, `.webp` allowed).

Default path when `savePath` is null: `public/generated/<slugify(prompt, 40)>-<sha.slice(0,7)>.png`.

### `generateImage(prompt: string, apiKey: string) → Buffer`

POSTs to `https://api.x.ai/v1/images/generations` with body:

```json
{
  "model": "grok-2-image-1212",
  "prompt": "<prompt>",
  "n": 1,
  "response_format": "b64_json"
}
```

Decodes the returned base64 PNG into a `Buffer`. The exact model ID is held in a workflow `env:` so it can be bumped without code changes.

### `writeAndCommit(absPath, buffer, branch, octokit, repo)`

- Writes the buffer to `absPath`, ensuring parent dir exists.
- Commits via `git` CLI configured as `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`. (Standard Actions bot identity, not the user — keeps `git blame` honest.)
- Commit message: `bot: grok-imagine "<truncated prompt>"`.
- Pushes to `branch`.

### `replyWithImage(octokit, repo, prNumber, repoRelPath)`

Posts a comment of the form:

```markdown
Generated `<repoRelPath>` for prompt "<truncated prompt>":

![grok-imagine](<repoRelPath>)
```

GitHub renders the relative-path image because the file now exists in the PR's head commit.

## Security & access control

- **Owner-only.** Workflow `if:` gate compares `github.event.comment.user.login == github.repository_owner`. Even if a stray external PR ever lands, no API call is made for non-owner comments.
- **Secret management.** `XAI_API_KEY` lives in repo Actions secrets. Never echoed, never written to disk.
- **Path validation.** `resolveOutputPath` rejects path traversal, absolute paths, and writes to sensitive directories (see Components above).
- **No fork support.** If `github.event.issue.pull_request.head.repo.fork` is true, the bot refuses with a comment and exits. Fork PRs can't receive pushes from `GITHUB_TOKEN` anyway.

## Failure modes

| Condition | Bot behavior |
|---|---|
| Comment body is `@grok-imagine` with no prompt | ❌ react + usage-hint comment. No API call. |
| Invalid `--save` path | ❌ react + "save path '<x>' is not allowed" comment. No API call. |
| xAI API returns 4xx/5xx | ❌ react + comment with truncated upstream error. |
| xAI returns malformed payload (no image) | ❌ react + "no image returned" comment. |
| Git push fails (e.g., branch force-pushed mid-run) | ❌ react + "couldn't push, retry" comment. |
| Fork PR | ❌ react + "fork PRs not supported" comment. |

## Cost & concurrency

- **One image per invocation.** No `--count` / batching flag. ~$0.07 per call (xAI pricing as of spec date — verify at implementation time).
- **Concurrency group:** `grok-imagine-${{ github.event.issue.number }}` so two near-simultaneous comments on the same PR queue rather than racing the git push.

## Testing

Minimal vitest coverage in `.github/scripts/grok-imagine.test.mjs`:

- `parseCommand`: happy path, `--save` path, missing prompt, unicode in prompt.
- `resolveOutputPath`: default-path generation, valid override, traversal rejection, absolute-path rejection, disallowed-extension rejection.

No integration tests against the live xAI API. No tests for the GitHub Actions side (the workflow is plumbing).

Run via existing `npm test`. Vitest's default include pattern is `**/*.{test,spec}.?(c|m)[jt]s?(x)`, which catches `.github/scripts/grok-imagine.test.mjs`. If the project's `vitest.config` narrows the include glob, widen it during implementation; do not leave it untested.

## Out of scope

- **Screenshot bot (option B from brainstorm).** Will get its own spec.
- **Multiple images per call.** One per comment.
- **Fork PR support.**
- **Prompt history / dedup.** Each invocation is independent.
- **Custom model selection from the comment.** Model is pinned in workflow `env`.
- **Image size / quality flags.** xAI's API has limited knobs; defaults are fine.
