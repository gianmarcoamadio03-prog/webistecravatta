import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Usi /api/img come proxy per Yupoo, quindi l'optimizer di Next
    // non viene mai invocato per immagini esterne. remotePatterns non serve.
    unoptimized: true,
  },
};

export default nextConfig;
