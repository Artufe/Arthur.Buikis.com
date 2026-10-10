import createMDX from '@next/mdx';
import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  pageExtensions: ['ts', 'tsx', 'mdx'],
  // Next 16.3+ appends a managed block to CLAUDE.md whenever `next dev` runs
  // under an AI agent. CLAUDE.md is hand-maintained here, so opt out.
  agentRules: false,
  // The dev badge lands in every GOLDENLINE review screenshot.
  devIndicators: false,
  turbopack: {
    rules: {
      // LITTLEBIG ships its shaders as `/* glsl */` template literals, which the JS minifier keeps
      // verbatim: strip their comments and whitespace at build time (~10 KB gzip). Dev too, so the
      // review shots run the same shader text as production.
      '*.ts': {
        condition: { all: [{ not: 'foreign' }, { path: /components\/littlebig\// }, { content: /\/\*\s*glsl\s*\*\// }] },
        loaders: [fileURLToPath(new URL('./scripts/glsl-minify.cjs', import.meta.url))],
      },
    },
  },
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
