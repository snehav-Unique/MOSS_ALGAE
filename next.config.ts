import type { NextConfig } from 'next';

const config: NextConfig = {
  images: { unoptimized: true },
  outputFileTracingRoot: process.cwd(),
};

export default config;
