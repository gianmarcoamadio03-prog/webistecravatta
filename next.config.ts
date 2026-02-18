import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // ✅ COST SAVER: evita l'optimizer di Next (/_next/image)
    // (meno compute + meno invocations su Vercel)
    unoptimized: true,

    // ✅ allowlist solo domini che usi davvero
    remotePatterns: [
      { protocol: "https", hostname: "photo.yupoo.com", pathname: "/**" },
      { protocol: "https", hostname: "**.yupoo.com", pathname: "/**" },
      { protocol: "https", hostname: "**.x.yupoo.com", pathname: "/**" },

      // Se ti servono altri domini reali, aggiungili qui (weidian/taobao ecc)
      // { protocol: "https", hostname: "**.weidian.com", pathname: "/**" },
      // { protocol: "https", hostname: "item.taobao.com", pathname: "/**" },
    ],

    // ✅ solo asset locali veri
    localPatterns: [{ pathname: "/agents/**" }],

    qualities: [70, 75],
  },
};

export default nextConfig;
