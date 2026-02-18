"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// ✅ joined lo teniamo "persistente" (localStorage) SOLO se vuoi evitare popup dopo join.
// ✅ dismissed lo teniamo "solo sessione" (sessionStorage) così a ogni riapertura torna.
const KEY_JOINED = "cravatta_tg_joined_v1";
const KEY_SESSION = "cravatta_tg_session_v1"; // values: "dismissed"
const TG_LINK = "https://t.me/cnfansbestfind";

function TelegramIcon({ className = "" }: { className?: string }) {
  // paper plane (Telegram-like)
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function XIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="currentColor">
      <path d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z" />
    </svg>
  );
}

function readJoined(): boolean {
  try {
    return localStorage.getItem(KEY_JOINED) === "1";
  } catch {
    return false;
  }
}

function writeJoined(v: boolean) {
  try {
    if (v) localStorage.setItem(KEY_JOINED, "1");
    else localStorage.removeItem(KEY_JOINED);
  } catch {}
}

function readSessionDismissed(): boolean {
  try {
    return sessionStorage.getItem(KEY_SESSION) === "dismissed";
  } catch {
    return false;
  }
}

function writeSessionDismissed() {
  try {
    sessionStorage.setItem(KEY_SESSION, "dismissed");
  } catch {}
}

export default function TelegramPopup({
  delayMs = 3000,
  collapseAfterMs = 3500, // quanto resta “larga” la pill dopo la chiusura
  showPopupEvenIfJoined = false, // ✅ se vuoi che il popup torni anche se uno ha già premuto "Entra"
}: {
  delayMs?: number;
  collapseAfterMs?: number;
  showPopupEvenIfJoined?: boolean;
}) {
  const pathname = usePathname();
  const isHome = pathname === "/";

  const [open, setOpen] = useState(false);

  // pillVisible: se deve esistere (pill o pallino)
  const [pillVisible, setPillVisible] = useState(false);

  // pillCompact: false = pill larga, true = pallino
  const [pillCompact, setPillCompact] = useState(true);

  const timerPopupRef = useRef<number | null>(null);
  const timerCollapseRef = useRef<number | null>(null);

  const clearTimers = () => {
    if (timerPopupRef.current) window.clearTimeout(timerPopupRef.current);
    if (timerCollapseRef.current) window.clearTimeout(timerCollapseRef.current);
    timerPopupRef.current = null;
    timerCollapseRef.current = null;
  };

  const collapseToDotLater = () => {
    if (timerCollapseRef.current) window.clearTimeout(timerCollapseRef.current);
    timerCollapseRef.current = window.setTimeout(() => {
      setPillCompact(true);
    }, collapseAfterMs);
  };

  useEffect(() => {
    clearTimers();

    if (!isHome) {
      setOpen(false);
      setPillVisible(false);
      return;
    }

    const joined = readJoined();
    const dismissedThisSession = readSessionDismissed();

    // ✅ DOT sempre visibile dopo dismiss (o dopo join)
    // - Se joined e NON vuoi popup: mostra solo dot.
    if (joined && !showPopupEvenIfJoined) {
      setOpen(false);
      setPillVisible(true);
      setPillCompact(true);
      return;
    }

    // ✅ Se ha chiuso il popup in questa sessione: niente popup, dot (compatto)
    if (dismissedThisSession) {
      setOpen(false);
      setPillVisible(true);
      setPillCompact(true);
      return;
    }

    // ✅ altrimenti: mostra popup dopo delay (ogni nuova “sessione”)
    timerPopupRef.current = window.setTimeout(() => {
      setOpen(true);
      setPillVisible(false);
    }, delayMs);

    return clearTimers;
  }, [isHome, delayMs, showPopupEvenIfJoined]);

  const closePopup = () => {
    // ✅ solo sessione: così chiudendo la scheda e riaprendo → torna
    writeSessionDismissed();

    setOpen(false);

    // ✅ dopo chiusura: pill larga per qualche secondo → poi pallino
    setPillVisible(true);
    setPillCompact(false);
    collapseToDotLater();
  };

  const join = () => {
    // ✅ opzionale: memorizza che ha cliccato “Entra”
    // così puoi decidere se non mostrargli più il popup (showPopupEvenIfJoined=false)
    writeJoined(true);

    // in questa sessione non rompere più: chiudi e passa a dot
    writeSessionDismissed();
    setOpen(false);
    setPillVisible(true);
    setPillCompact(true);

    window.open(TG_LINK, "_blank", "noopener,noreferrer");
  };

  if (!isHome) return null;

  const tgGradient = "linear-gradient(135deg, #2AABEE 0%, #229ED9 55%, #1E88D3 100%)";

  return (
    <>
      {/* POPUP */}
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          {/* overlay trasparente (solo click-out) */}
          <button
            aria-label="Chiudi popup"
            className="absolute inset-0 bg-transparent"
            onClick={closePopup}
          />

          <div className="relative w-full max-w-[560px] overflow-hidden rounded-[28px] border border-white/12 bg-[#0b0b0c]/55 backdrop-blur-xl shadow-[0_30px_120px_rgba(0,0,0,0.65)]">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-28 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full blur-3xl"
              style={{
                background: "radial-gradient(closest-side, rgba(42,171,238,0.18), transparent 70%)",
              }}
            />

            <div className="relative flex items-start justify-between gap-4 px-6 pt-6">
              <div className="flex items-start gap-3">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/12 bg-white/7 text-white">
                  <TelegramIcon className="h-[22px] w-[22px]" />
                </div>

                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.32em] text-white/40">
                    community
                  </div>
                  <div className="mt-1 text-[22px] leading-[1.15] font-semibold text-white">
                    Entra nel gruppo Telegram
                  </div>
                </div>
              </div>

              <button
                onClick={closePopup}
                aria-label="Chiudi"
                className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white/8 hover:text-white/90 transition"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="relative px-6 pb-6 pt-5">
              <div className="h-px w-full bg-white/10" />

              <div className="mt-5">
                <button
                  onClick={join}
                  className="w-full h-12 rounded-full text-white font-semibold shadow-[0_12px_36px_rgba(0,0,0,0.38)] transition hover:opacity-95 active:opacity-90"
                  style={{ background: tgGradient }}
                >
                  <span className="inline-flex items-center justify-center gap-2">
                    <TelegramIcon className="h-5 w-5 text-white" />
                    Entra ora →
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PILL / DOT (persistente dopo dismiss/join) */}
      {pillVisible && !open && (
        <div
          className="fixed z-[9998]"
          style={{
            bottom: "calc(16px + env(safe-area-inset-bottom))",
            right: "calc(16px + env(safe-area-inset-right))",
          }}
        >
          <button
            onClick={join}
            aria-label="Apri Telegram"
            className={[
              "group relative overflow-hidden border border-white/12 backdrop-blur-xl shadow-[0_20px_70px_rgba(0,0,0,0.55)] transition-all duration-300 ease-out",
              "text-white", // ✅ importantissimo: l’icona usa currentColor
              pillCompact ? "h-12 w-12 rounded-full p-0" : "h-14 rounded-full px-4 py-3",
              "bg-[#0b0b0c]/55 hover:bg-[#0b0b0c]/65",
            ].join(" ")}
          >
            {/* hover glow */}
            <span
              aria-hidden
              className="absolute left-0 top-0 h-full w-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{
                background:
                  "radial-gradient(circle at 20% 20%, rgba(42,171,238,0.22), transparent 55%)",
              }}
            />

            <span className="relative flex items-center gap-3">
              {/* ICONA */}
<span
  className={[
    "relative shrink-0 rounded-full border border-white/12",
    pillCompact ? "h-12 w-12" : "h-9 w-9",
  ].join(" ")}
  style={{ background: tgGradient }}
>
  {/* centra al 100% indipendentemente da line-height */}
  <span className="absolute inset-0 m-auto grid place-items-center">
   <TelegramIcon
  className={[
    "text-white",
    pillCompact ? "h-6 w-6" : "h-5 w-5",
    // ✅ offset ottico più forte: sposta GIÙ e a DESTRA
    "translate-x-0 translate-y-[1.25px]",
  ].join(" ")}
/>
  </span>
</span>


              {/* TESTO/CTA solo pill larga */}
              {!pillCompact && (
                <>
                  <span className="leading-tight text-left">
                    <span className="block text-sm font-semibold">Telegram</span>
                    <span className="block text-[12px] text-white/60">Unisciti al gruppo</span>
                  </span>

                  <span className="ml-2 inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-white/95 border border-white/10 bg-white/5 group-hover:bg-white/8 transition">
                    Entra →
                  </span>
                </>
              )}
            </span>
          </button>
        </div>
      )}
    </>
  );
}
