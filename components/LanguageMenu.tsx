"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const COOKIE_NAME = "cc_lang";
const LS_KEY = "cc_lang";

type Lang = {
  code: string;
  label: string;
  short: string;
};

const LANGS: Lang[] = [
  { code: "it", label: "Italiano", short: "IT" },
  { code: "en", label: "English", short: "EN" },
  { code: "fr", label: "Français", short: "FR" },
  { code: "de", label: "Deutsch", short: "DE" },
  { code: "es", label: "Español", short: "ES" },
  { code: "ru", label: "Русский", short: "RU" },
  { code: "zh", label: "中文", short: "ZH" },
];

function isSupported(code: string | null | undefined) {
  if (!code) return false;
  return LANGS.some((l) => l.code === code);
}

function getCookie(name: string) {
  try {
    const m = document.cookie.match(
      new RegExp(`(?:^|; )${name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&")}=([^;]*)`)
    );
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function setCookie(name: string, value: string) {
  // 1 anno
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

export default function LanguageMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<string>("it");

  const rootRef = useRef<HTMLDivElement | null>(null);

  const current = useMemo(
    () => LANGS.find((l) => l.code === lang) ?? LANGS[0],
    [lang]
  );

  // bootstrap: query ?lang=xx -> cookie -> localStorage -> default
  useEffect(() => {
    const qp = sp?.get("lang");
    if (isSupported(qp)) {
      setCookie(COOKIE_NAME, qp!);
      try {
        localStorage.setItem(LS_KEY, qp!);
      } catch {}
      setLang(qp!);

      // opzionale: pulisci query param
      if (pathname) router.replace(pathname);
      return;
    }

    const c = getCookie(COOKIE_NAME);
    if (isSupported(c)) {
      setLang(c!);
      try {
        localStorage.setItem(LS_KEY, c!);
      } catch {}
      return;
    }

    try {
      const ls = localStorage.getItem(LS_KEY);
      if (isSupported(ls)) {
        setCookie(COOKIE_NAME, ls!);
        setLang(ls!);
        return;
      }
    } catch {}

    // default
    setCookie(COOKIE_NAME, "it");
    setLang("it");
  }, [pathname, router, sp]);

  // aggiorna <html lang="...">
  useEffect(() => {
    try {
      document.documentElement.lang = lang || "it";
    } catch {}
  }, [lang]);

  // close on outside / esc
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const apply = (code: string) => {
    if (!isSupported(code)) return;
    setCookie(COOKIE_NAME, code);
    try {
      localStorage.setItem(LS_KEY, code);
    } catch {}
    setLang(code);
    setOpen(false);

    // fa “rinfrescare” i Server Components se in futuro userai il cookie per traduzioni
    router.refresh();
  };

  return (
    <div
      ref={rootRef}
      className="fixed z-[9997]"
      style={{
        top: "calc(12px + env(safe-area-inset-top))",
        right: "calc(12px + env(safe-area-inset-right))",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group inline-flex items-center gap-2 rounded-full border border-white/12 bg-[#0b0b0c]/55 px-3 py-2 text-xs text-white/85 backdrop-blur-xl shadow-[0_18px_60px_rgba(0,0,0,0.55)] hover:bg-[#0b0b0c]/65 transition"
        aria-label="Seleziona lingua"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full border border-white/12 bg-white/7 text-[11px] font-semibold">
          {current.short}
        </span>
        <span className="hidden sm:block max-w-[120px] truncate">{current.label}</span>
        <svg
          className={`h-4 w-4 text-white/70 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="mt-2 w-[220px] overflow-hidden rounded-2xl border border-white/12 bg-[#0b0b0c]/70 backdrop-blur-xl shadow-[0_30px_90px_rgba(0,0,0,0.65)]">
          <div className="p-2">
            {LANGS.map((l) => {
              const active = l.code === lang;
              return (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => apply(l.code)}
                  className={[
                    "w-full flex items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition",
                    active ? "bg-white/10 text-white" : "hover:bg-white/7 text-white/85",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-3">
                    <span className="grid h-7 w-7 place-items-center rounded-full border border-white/12 bg-white/6 text-[11px] font-semibold">
                      {l.short}
                    </span>
                    <span>{l.label}</span>
                  </span>

                  {active && (
                    <svg
                      className="h-4 w-4 text-white/80"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t border-white/10 px-3 py-2 text-[11px] text-white/45">
            La scelta viene salvata sul dispositivo.
          </div>
        </div>
      )}
    </div>
  );
}
