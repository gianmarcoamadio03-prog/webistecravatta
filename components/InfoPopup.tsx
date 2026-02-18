"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const KEY = "cravatta_info_v1";

type Status = "dismissed" | null;

function InfoIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10.5v6" />
      <path d="M12 7.5h.01" />
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

function readStatus(): Status {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dismissed" ? "dismissed" : null;
  } catch {
    return null;
  }
}

function writeStatus(v: Exclude<Status, null>) {
  try {
    localStorage.setItem(KEY, v);
  } catch {}
}

type Props = {
  delayMs?: number;
  showOn?: string[]; // es: ["/spreadsheet", "/sellers"]
};

export default function InfoPopup({ delayMs = 2500, showOn = ["/spreadsheet", "/sellers"] }: Props) {
  const pathname = usePathname();

  const isAllowed = useMemo(() => {
    const p = pathname || "/";
    return showOn.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
  }, [pathname, showOn]);

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const timerPopupRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerPopupRef.current) window.clearTimeout(timerPopupRef.current);
    timerPopupRef.current = null;
  };

  // Leggi status quando entri/torni su pagine abilitate
  useEffect(() => {
    if (!isAllowed) {
      setOpen(false);
      setStatus(null);
      clearTimer();
      return;
    }
    setStatus(readStatus());
  }, [isAllowed]);

  // Auto-open solo se NON è dismissed
  useEffect(() => {
    clearTimer();

    if (!isAllowed) return;

    if (status === "dismissed") {
      setOpen(false);
      return;
    }

    // prima volta: mostra popup dopo delay
    timerPopupRef.current = window.setTimeout(() => {
      setOpen(true);
    }, delayMs);

    return clearTimer;
  }, [isAllowed, status, delayMs]);

  const closePopup = () => {
    writeStatus("dismissed");
    setStatus("dismissed");
    setOpen(false);
  };

  const reopen = () => {
    setOpen(true);
  };

  if (!isAllowed) return null;

  // ---- COPY (rigoroso) ----
  const EYEBROW = "INFO";
  const TITLE = "Avviso legale";
  const SUBTITLE = "Limitazione di responsabilità";

  const BODY = (
    <>
      <p className="text-sm text-white/75 leading-relaxed">
        Il presente sito web è fornito esclusivamente a scopo informativo e di aggregazione di risorse.
        Il sito <b>non vende alcun articolo</b>, <b>non fornisce servizi di acquisto</b>, <b>non opera come intermediario</b> e
        <b> non rappresenta</b> venditori, marketplace o agent di terze parti (salvo diversa indicazione esplicita).
      </p>

      <p className="mt-3 text-sm text-white/75 leading-relaxed">
        Qualsiasi collegamento o riferimento a servizi/contenuti di terzi è pubblicato <b>senza garanzia</b>.
        Eventuali operazioni o transazioni avvengono <b>esclusivamente</b> tra l’utente e la terza parte.
        L’utente è l’unico responsabile di ogni valutazione e scelta, inclusi (a titolo esemplificativo):
        pagamenti, spedizioni, dogane, resi, rimborsi, reclami e conformità alle normative applicabili.
      </p>

      <p className="mt-3 text-sm text-white/75 leading-relaxed">
        Nei limiti massimi consentiti dalla legge, il sito e i suoi gestori <b>declinano ogni responsabilità</b> per:
        autenticità/originalità/provenienza degli articoli; qualità, conformità o disponibilità; accuratezza di descrizioni,
        immagini o prezzi; operato, inadempimenti o indisponibilità di terzi; nonché per qualsiasi danno diretto o indiretto,
        perdita economica, ritardo, sequestro, contestazione, costo doganale o altra conseguenza derivante dall’uso di link o servizi esterni.
      </p>

      <p className="mt-3 text-sm text-white/75 leading-relaxed">
        Proseguendo nella navigazione, l’utente dichiara di comprendere e accettare che ogni decisione di acquisto è assunta
        <b> in autonomia</b> e sotto la propria esclusiva responsabilità.
      </p>
    </>
  );

  return (
    <>
      {/* POPUP */}
      {open && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          {/* overlay trasparente */}
          <button aria-label="Chiudi popup" className="absolute inset-0 bg-transparent" onClick={closePopup} />

          <div className="relative w-full max-w-[640px] overflow-hidden rounded-[28px] border border-white/12 bg-[#0b0b0c]/55 backdrop-blur-xl shadow-[0_30px_120px_rgba(0,0,0,0.65)]">
            {/* glow soft */}
            <div
              aria-hidden
              className="pointer-events-none absolute -top-28 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full blur-3xl"
              style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.14), transparent 70%)" }}
            />

            {/* HEADER (fix gerarchia) */}
            <div className="relative flex items-start justify-between gap-4 px-6 pt-6">
              <div className="flex items-start gap-3">
                <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/12 bg-white/7 text-white">
                  <InfoIcon className="block h-[22px] w-[22px]" />
                </div>

                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.32em] text-white/45">{EYEBROW}</div>
                  <div className="mt-1 text-[22px] leading-[1.12] font-semibold tracking-tight text-white">
                    {TITLE}
                  </div>
                  <div className="mt-1 text-sm text-white/60">{SUBTITLE}</div>
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closePopup();
                }}
                aria-label="Chiudi"
                className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-white/5 text-white/70 hover:bg-white/8 hover:text-white/90 transition"
              >
                <XIcon className="h-5 w-5" />
              </button>
            </div>

            {/* BODY */}
            <div className="relative px-6 pb-6 pt-5">
              <div className="h-px w-full bg-white/10" />

              <div className="mt-4 max-h-[52vh] overflow-y-auto pr-1">{BODY}</div>

              <div className="mt-5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closePopup();
                  }}
                  className="w-full h-12 rounded-full bg-white text-black font-semibold hover:opacity-90 transition"
                >
                  Ho compreso
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* DOT “i” — SEMPRE presente su pagine abilitate quando il popup è chiuso */}
      {!open && (
        <div
          className="fixed z-[9998]"
          style={{
            bottom: "calc(16px + env(safe-area-inset-bottom))",
            right: "calc(16px + env(safe-area-inset-right))",
          }}
        >
          <button
            onClick={reopen}
            aria-label="Apri informazioni"
            className="group h-12 w-12 rounded-full border border-white/12 bg-[#0b0b0c]/55 backdrop-blur-xl shadow-[0_20px_70px_rgba(0,0,0,0.55)] hover:bg-[#0b0b0c]/65 transition"
          >
            <span className="grid h-full w-full place-items-center text-white">
              {/* micro-nudge ottico a sinistra */}
              <InfoIcon className="block h-6 w-6 -translate-x-[0.5px]" />
            </span>
          </button>
        </div>
      )}
    </>
  );
}
