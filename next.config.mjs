import createMDX from '@next/mdx';

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
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
