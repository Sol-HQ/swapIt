import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Allow production builds even if there are ESLint errors (we manage incrementally)
    ignoreDuringBuilds: true,
  },
  typescript: {
    // (Optional) Uncomment to allow production build with type errors
    // ignoreBuildErrors: true,
  },
};

export default nextConfig;
