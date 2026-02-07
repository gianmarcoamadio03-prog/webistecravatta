import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cravatta",
  description: "Cravatta — Spreadsheet e risorse",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it" className="bg-black [color-scheme:dark]">
      <body
        className={[
          // ✅ su macOS: system-ui = SF Pro (feeling più “Apple”)
          "min-h-[100dvh] bg-black text-white antialiased font-sans",
          "selection:bg-white/20 selection:text-white",
        ].join(" ")}
      >
        {children}
      </body>
    </html>
  );
}
