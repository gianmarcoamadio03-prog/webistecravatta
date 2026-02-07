import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // per immagini esterne dirette (se ti servono)
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],

    // ✅ permette /api/img?url=....
    // (omettendo "search" accetti tutte le query string)
    localPatterns: [
      { pathname: "/api/img" },
      { pathname: "/api/img/**" },
      { pathname: "/agents/**" },
    ],

    // ✅ se in <Image quality={70} />
    qualities: [70, 75],
  },
};

export default nextConfig;
