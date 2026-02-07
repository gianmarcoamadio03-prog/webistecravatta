"use client";

import { useMemo, useState } from "react";

type Props = {
  item: {
    title?: string;
    slug?: string;
    seller?: string;
    category?: string;
    source_url?: string;
    sheet_row?: number | string;
    sheet_id?: string;
    sheet_tab?: string;
  };
  className?: string;
};

export default function ReportItemButton({ item, className }: Props) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  const payload = useMemo(() => {
    const page_url = typeof window !== "undefined" ? window.location.href : "";
    return { ...item, page_url };
  }, [item]);

  async function onClick() {
    if (status === "sending") return;

    setStatus("sending");
    try {
      const res = await fetch("/api/report-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error("request failed");
      setStatus("sent");
      window.setTimeout(() => setStatus("idle"), 2200);
    } catch {
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 2400);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={onClick}
        className="w-full mt-3 rounded-2xl border border-white/12 bg-white/[0.04] px-4 py-3 text-sm text-white/85 hover:bg-white/[0.06] active:scale-[0.99] transition"
      >
        {status === "sending" ? "Invio segnalazione…" : "Segnala un problema"}
      </button>

      {/* Overlay premium */}
      {status === "sent" ? (
        <Overlay text="L’assistenza è stata notificata ✅" />
      ) : status === "error" ? (
        <Overlay text="Errore: riprova tra poco" />
      ) : null}
    </div>
  );
}

function Overlay({ text }: { text: string }) {
  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center pointer-events-none">
      <div className="rounded-2xl border border-white/12 bg-black/55 backdrop-blur-xl px-5 py-4 text-sm text-white/90 shadow-[0_30px_120px_rgba(0,0,0,0.6)] animate-[fadeIn_.18s_ease-out]">
        {text}
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(6px) scale(0.985);
            filter: blur(2px);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: blur(0);
          }
        }
      `}</style>
    </div>
  );
}
