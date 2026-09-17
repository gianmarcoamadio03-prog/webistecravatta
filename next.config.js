// next.config.js
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

export default withBundleAnalyzer({
  reactStrictMode: true,

  // Collega /go-7k3x alla middle page
  async rewrites() {
    return [
      { source: "/go-7k3x", destination: "/go-7k3x/index.html" },
    ];
  },

  // Dice a Google di non indicizzare la middle page
  async headers() {
    return [
      {
        source: "/go-7k3x/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
});