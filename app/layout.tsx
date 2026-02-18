import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

import TelegramPopup from "@/components/TelegramPopup";
import InfoPopup from "@/components/InfoPopup";

export const metadata: Metadata = {
  title: "Cravatta",
  description: "Cravatta — Spreadsheet e risorse",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it" className="bg-black [color-scheme:dark]">
      <body
        className={[
          "min-h-[100dvh] bg-black text-white antialiased font-sans",
          "selection:bg-white/20 selection:text-white",
          "overflow-x-hidden",
        ].join(" ")}
      >
        {children}

        {/* ✅ Home only (gestito dentro al componente) */}
        <TelegramPopup delayMs={3000} />

        {/* ✅ Solo /spreadsheet e /sellers */}
       <InfoPopup
  delayMs={2500}
  showOn={["/spreadsheet", "/sellers"]}
/>


        <Analytics />
      </body>
    </html>
  );
}
