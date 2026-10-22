import type { NextConfig } from 'next';

const config: NextConfig = {
  images: { unoptimized: true },
  outputFileTracingRoot: process.cwd(),
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const backend = (process.env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
    return [{source: '/api/:path*', destination: `${backend}/api/:path*`}];
  },
};

export default config;
