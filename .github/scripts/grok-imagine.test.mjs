import { describe, expect, it } from 'vitest';
import {
  BadCommand,
  UnsafePath,
  parseCommand,
  resolveOutputPath,
  slugify,
} from './grok-imagine.mjs';

describe('parseCommand', () => {
  it('parses a bare prompt', () => {
    expect(parseCommand('@grok-imagine a glowing CRT')).toEqual({
      prompt: 'a glowing CRT',
      savePath: null,
    });
  });

  it('parses --save with a path and prompt', () => {
    expect(parseCommand('@grok-imagine --save public/og.png a moody portrait')).toEqual({
      prompt: 'a moody portrait',
      savePath: 'public/og.png',
    });
  });

  it('preserves unicode in the prompt', () => {
    const out = parseCommand('@grok-imagine 北京 in neon — moody');
    expect(out.prompt).toBe('北京 in neon — moody');
    expect(out.savePath).toBeNull();
  });

  it('rejects an empty prompt', () => {
    expect(() => parseCommand('@grok-imagine   ')).toThrow(BadCommand);
  });

  it('rejects --save without a prompt', () => {
    expect(() => parseCommand('@grok-imagine --save public/og.png')).toThrow(BadCommand);
  });

  it('rejects a body that is not a grok-imagine command', () => {
    expect(() => parseCommand('hey can you make me an image')).toThrow(BadCommand);
  });
});

describe('resolveOutputPath', () => {
  const repoRoot = '/repo';
  const sha = 'abcdef1234567890';

  it('builds a default path under public/generated', () => {
    const out = resolveOutputPath({
      savePath: null,
      prompt: 'A Glowing CRT in Vaporwave Colors!',
      sha,
      repoRoot,
    });
    expect(out.rel).toBe('public/generated/a-glowing-crt-in-vaporwave-colors-abcdef1.png');
  });

  it('accepts a valid override', () => {
    const out = resolveOutputPath({
      savePath: 'public/og.png',
      prompt: 'irrelevant',
      sha,
      repoRoot,
    });
    expect(out.rel).toBe('public/og.png');
  });

  it('rejects path traversal', () => {
    expect(() =>
      resolveOutputPath({ savePath: '../etc/passwd.png', prompt: 'x', sha, repoRoot }),
    ).toThrow(UnsafePath);
  });

  it('rejects absolute paths', () => {
    expect(() =>
      resolveOutputPath({ savePath: '/etc/passwd.png', prompt: 'x', sha, repoRoot }),
    ).toThrow(UnsafePath);
  });

  it('rejects writes under .github/workflows/', () => {
    expect(() =>
      resolveOutputPath({
        savePath: '.github/workflows/evil.png',
        prompt: 'x',
        sha,
        repoRoot,
      }),
    ).toThrow(UnsafePath);
  });

  it('rejects non-image extensions', () => {
    expect(() =>
      resolveOutputPath({ savePath: 'public/script.sh', prompt: 'x', sha, repoRoot }),
    ).toThrow(UnsafePath);
  });
});

describe('slugify', () => {
  it('falls back to "image" when input has no usable chars', () => {
    expect(slugify('!!!')).toBe('image');
  });

  it('strips diacritics', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume');
  });
});
