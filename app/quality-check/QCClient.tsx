"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";

type QcResult = {
  score: number;
  summary: string;
  pros: string[];
  cons: string[];
};

const MAX_IMAGES = 4 as const;

// ✅ COST-SAVER (immagini)
const COMPRESS_MAX_SIDE = 512;
const JPEG_QUALITY = 0.78;

// ✅ COST-SAVER (testo note)
const NOTES_MAX_CHARS = 220;

const LOADING_UI: "overlay" | "inline" = "overlay";

async function compressToBudgetJpeg(file: File): Promise<File> {
  try {
    if (!file.type?.startsWith("image/")) return file;

    // HEIC: spesso il browser non lo ricomprime bene → lasciamo gestire al server
    if (/heic/i.test(file.type)) return file;

    // già jpeg e piccolo: skip
    if (file.type === "image/jpeg" && file.size <= 350_000) return file;

    const img = await createImageBitmap(file);
    const maxDim = Math.max(img.width, img.height);

    const scale = Math.min(1, COMPRESS_MAX_SIDE / maxDim);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    // Se non ridimensiona e non serve re-encode, lascia
    if (scale === 1 && file.type === "image/jpeg" && file.size <= 500_000) {
      img.close?.();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      img.close?.();
      return file;
    }

    // Fondo bianco utile per PNG trasparenti
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    ctx.drawImage(img, 0, 0, w, h);
    img.close?.();

    const blob: Blob | null = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", JPEG_QUALITY)
    );
    if (!blob) return file;

    // Se più pesante dell'originale → tieni l'originale
    if (blob.size >= file.size && file.size > 0) return file;

    const outName = file.name.replace(/\.\w+$/, "") + ".jpg";
    return new File([blob], outName, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function clamp01_100(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cn(s: (string | false | null | undefined)[]) {
  return s.filter(Boolean).join(" ");
}

function GlassButton({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  type?: "button" | "submit";
  className?: string;
}) {
  const base =
    "rounded-full border px-4 py-2 text-xs backdrop-blur transition disabled:opacity-50 disabled:cursor-not-allowed";
  const cls =
    variant === "primary"
      ? "border-white/12 bg-white/10 hover:bg-white/15 text-white/90"
      : "border-white/10 bg-white/[0.05] hover:bg-white/10 text-white/80";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn([base, cls, className])}
    >
      {children}
    </button>
  );
}

function GlassLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn([
        "inline-flex items-center rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-xs text-white/80 backdrop-blur transition hover:bg-white/10",
        className,
      ])}
    >
      {children}
    </Link>
  );
}

function TinyChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">
      {children}
    </span>
  );
}

export default function QCClient() {
  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [quotaHint, setQuotaHint] = useState<string | null>(null);
  const [softHint, setSoftHint] = useState<string | null>(null);

  const [result, setResult] = useState<QcResult | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [isMock, setIsMock] = useState<boolean | null>(null);

  const [dragOver, setDragOver] = useState(false);

  const [progress, setProgress] = useState(0);
  const [scoreAnim, setScoreAnim] = useState(0);

  const galleryRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  const previews = useMemo(() => {
    return files.map((f) => ({ file: f, url: URL.createObjectURL(f) }));
  }, [files]);

  useEffect(() => {
    return () => previews.forEach((p) => URL.revokeObjectURL(p.url));
  }, [previews]);

  // paste immagini
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (loading) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imgItems = items.filter((it) => it.type?.startsWith("image/"));
      if (!imgItems.length) return;

      const pasted: File[] = [];
      imgItems.forEach((it) => {
        const f = it.getAsFile();
        if (f) pasted.push(f);
      });

      if (pasted.length) addFiles(pasted);
    };

    window.addEventListener("paste", onPaste as any);
    return () => window.removeEventListener("paste", onPaste as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // progress “smart”
  useEffect(() => {
    if (!loading) return;

    setProgress(8);
    const started = performance.now();

    const id = window.setInterval(() => {
      const t = (performance.now() - started) / 1000;
      const target = 92;
      const eased = target * (1 - Math.exp(-t * 1.15));
      setProgress((p) => Math.min(target, Math.max(p, Math.round(eased))));
    }, 120);

    return () => window.clearInterval(id);
  }, [loading]);

  // anima score
  useEffect(() => {
    if (!result) return;

    const to = clamp01_100(result.score);
    const from = 0;
    const duration = 900;

    let raf = 0;
    const start = performance.now();

    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setScoreAnim(Math.round(from + (to - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };

    setScoreAnim(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [result]);

  function resetAll() {
    setFiles([]);
    setNotes("");
    setResult(null);
    setRemaining(null);
    setError(null);
    setQuotaHint(null);
    setSoftHint(null);
    setDragOver(false);
    setProgress(0);
    setScoreAnim(0);
    setIsMock(null);
  }

  function removeAt(idx: number) {
    if (loading) return;
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function addFiles(incoming: File[]) {
    if (loading) return;

    const picked = incoming.filter((f) => f.type?.startsWith("image/"));
    if (!picked.length) return;

    setError(null);
    setQuotaHint(null);
    setRemaining(null);
    setResult(null);
    setSoftHint(null);
    setIsMock(null);

    setFiles((prev) => {
      const key = (f: File) => `${f.name}_${f.size}_${f.lastModified}`;
      const seen = new Set(prev.map(key));
      const merged: File[] = [...prev];

      for (const f of picked) {
        const k = key(f);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(f);
      }

      if (merged.length > MAX_IMAGES) {
        setSoftHint(`Max ${MAX_IMAGES} foto. Ho tenuto le prime ${MAX_IMAGES}.`);
        return merged.slice(0, MAX_IMAGES);
      }
      return merged;
    });
  }

  function onPickGallery(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files || []);
    addFiles(picked);
    e.target.value = "";
  }

  function onPickCamera(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files || []);
    addFiles(picked.slice(0, 1));
    e.target.value = "";
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (loading) return;
    setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (loading) return;
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files || []);
    addFiles(dropped);
  }

  async function submit() {
    setLoading(true);
    setError(null);
    setQuotaHint(null);
    setSoftHint(null);
    setResult(null);
    setIsMock(null);
    setProgress(8);

    try {
      if (files.length === 0) throw new Error("Carica almeno 1 foto.");

      const processed = await Promise.all(files.map(compressToBudgetJpeg));

      const fd = new FormData();
      processed.forEach((f) => fd.append("images", f, f.name));

      const cleanNotes = notes.trim().slice(0, NOTES_MAX_CHARS);
      if (cleanNotes) fd.append("notes", cleanNotes);

      const res = await fetch("/api/qc/analyze", {
        method: "POST",
        body: fd,
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (data?.error === "HEIC_NOT_SUPPORTED") {
          setError(
            "Formato HEIC non supportato. Usa JPG/PNG (o abilita conversione lato telefono)."
          );
          return;
        }

        if (res.status === 402) {
          setQuotaHint(
            "⚠️ Billing/crediti OpenAI non attivi: la UI funziona, ma l’analisi AI non parte."
          );
          setError("Attiva billing/crediti sul progetto OpenAI e riprova.");
          return;
        }

        if (res.status === 429) {
          setError(
            data?.error === "DAILY_LIMIT_REACHED"
              ? "Limite giornaliero raggiunto."
              : "Rate limit. Riprova tra poco."
          );
          if (typeof data?.remainingToday === "number")
            setRemaining(data.remainingToday);
          return;
        }

        setError(data?.message || data?.error || "Errore inatteso.");
        return;
      }

      setProgress(100);
      setTimeout(() => setProgress(0), 350);

      setResult(data.result as QcResult);
      setIsMock(Boolean(data?.mock));
      if (typeof data?.remainingToday === "number")
        setRemaining(data.remainingToday);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const scoreTarget = result ? clamp01_100(result.score) : 0;
  const score = clamp01_100(scoreAnim);

  const pros = (result?.pros ?? []).slice(0, 3);
  const cons = (result?.cons ?? []).slice(0, 3);

  const GRADIENT =
    "linear-gradient(90deg,#ff3b30 0%,#ff9f0a 25%,#ffd60a 50%,#a8e10c 75%,#34c759 100%)";

  const clipFill =
    score <= 0
      ? "inset(0 100% 0 0 round 9999px)"
      : score >= 100
      ? "inset(0 0% 0 0 round 9999px)"
      : `inset(0 ${100 - score}% 0 0 round 9999px)`;

  const canAddMore = files.length < MAX_IMAGES && !loading;

  return (
    <div className="w-full max-w-5xl pb-24 md:pb-0">
      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-70%); opacity: .20; }
          50% { opacity: .55; }
          100% { transform: translateX(170%); opacity: .20; }
        }
      `}</style>

      <div className="mb-3 flex items-center justify-start">
        <GlassLink href="/">← Home</GlassLink>
      </div>

      <div className="relative overflow-hidden rounded-[34px] border border-white/10 bg-white/[0.04] px-6 py-5 backdrop-blur-xl shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_30px_90px_rgba(0,0,0,0.55)]">
        <div className="pointer-events-none absolute -top-28 left-1/2 h-52 w-[620px] -translate-x-1/2 rounded-full bg-white/10 blur-3xl" />

        <div className="relative">
          <div className="mx-auto flex flex-col items-center gap-2 text-center">
            <div className="flex items-center justify-center gap-3">
              <span className="rounded-full border border-white/10 bg-white/[0.06] px-3 py-1 text-sm tracking-[0.35em] text-white/70">
                AI
              </span>

              {isMock != null ? (
                <span
                  className={cn([
                    "rounded-full border px-3 py-1 text-[11px] tracking-[0.25em] backdrop-blur",
                    isMock
                      ? "border-amber-400/20 bg-amber-400/10 text-amber-200/90"
                      : "border-emerald-400/20 bg-emerald-500/10 text-emerald-200/90",
                  ])}
                >
                  {isMock ? "MOCK" : "LIVE"}
                </span>
              ) : null}

              <div className="text-2xl font-semibold tracking-tight text-white">
                Quality Check
              </div>
            </div>

            {/* Mobile: micro-stepper leggero */}
            <div className="md:hidden text-[12px] text-white/45">
              1) Foto → 2) Note → 3) Risultato
            </div>
          </div>

          <div className="mt-3 flex justify-center md:mt-0 md:absolute md:right-0 md:top-0 md:justify-end">
            <GlassButton onClick={resetAll} disabled={loading} variant="ghost">
              Nuovo QC
            </GlassButton>
          </div>
        </div>

        {/* UPLOAD (DESKTOP invariato + MOBILE strip) */}
        <div className="relative mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-white/80">
              Carica foto{" "}
              <span className="text-white/45 tabular-nums">
                ({files.length}/{MAX_IMAGES})
              </span>
            </div>

            <div className="flex items-center gap-2">
              <GlassButton
                onClick={() => cameraRef.current?.click()}
                disabled={loading || files.length >= MAX_IMAGES}
              >
                Scatta
              </GlassButton>
              <GlassButton
                onClick={() => galleryRef.current?.click()}
                disabled={loading || files.length >= MAX_IMAGES}
              >
                Galleria
              </GlassButton>

              <input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onPickCamera}
              />
              <input
                ref={galleryRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={onPickGallery}
              />
            </div>
          </div>

          {/* ✅ MOBILE: strip foto + X (niente box enorme) */}
          <div className="md:hidden mt-3">
            {files.length === 0 ? (
              <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/55">
                Nessuna foto caricata. Usa <span className="text-white/75 font-semibold">Aggiungi</span> in basso.
              </div>
            ) : (
              <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-white/45">
                    Foto caricate
                  </div>
                  <div className="flex gap-2">
                    <TinyChip>Front</TinyChip>
                    <TinyChip>Back</TinyChip>
                    <TinyChip>Close-up</TinyChip>
                    <TinyChip>Tag</TinyChip>
                  </div>
                </div>

                <div className="mt-3 flex gap-3 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
                  {previews.map((p, idx) => (
                    <div
                      key={p.url}
                      className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black/30"
                    >
                      <img
                        src={p.url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeAt(idx)}
                        disabled={loading}
                        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-[12px] text-white/90 disabled:opacity-50"
                        aria-label="Rimuovi"
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  {files.length < MAX_IMAGES ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!loading) galleryRef.current?.click();
                      }}
                      className="h-16 w-16 shrink-0 rounded-xl border border-dashed border-white/15 bg-white/[0.02] text-sm text-white/60"
                      disabled={loading}
                    >
                      +
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          {/* ✅ DESKTOP: dropzone originale (invariato) */}
          <div
            className={cn([
              "hidden md:block mt-3 rounded-3xl border bg-black/20 transition relative overflow-hidden",
              dragOver ? "border-white/30 bg-white/[0.06]" : "border-white/10",
            ])}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => {
              if (!loading) galleryRef.current?.click();
            }}
            role="button"
            tabIndex={0}
          >
            <div className="pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]">
              <div className="absolute -left-1/3 top-0 h-full w-1/2 bg-white/10 blur-xl animate-[shimmer_3.3s_ease-in-out_infinite]" />
            </div>

            <div className="relative p-6">
              {files.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02] py-16 md:py-20 text-center">
                  <div className="text-base md:text-lg text-white/85">
                    Trascina o clicca per scegliere
                  </div>
                  <div className="mt-2 text-[11px] text-white/40">
                    Suggerito: front • back • close-up • tag/logo (max 4)
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] text-white/45">
                      Clicca per aggiungere altre • Max {MAX_IMAGES}
                    </div>
                    <div className="flex gap-2">
                      <TinyChip>Front</TinyChip>
                      <TinyChip>Back</TinyChip>
                      <TinyChip>Close-up</TinyChip>
                      <TinyChip>Tag</TinyChip>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
                    {previews.map((p, idx) => (
                      <div
                        key={p.url}
                        className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/30"
                      >
                        <img
                          src={p.url}
                          alt=""
                          className="h-28 md:h-32 w-full object-cover opacity-90"
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeAt(idx);
                          }}
                          disabled={loading}
                          className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-1 text-[11px] text-white/85 hover:bg-black/75 disabled:opacity-50"
                        >
                          Rimuovi
                        </button>
                      </div>
                    ))}

                    {files.length < MAX_IMAGES ? (
                      <div className="flex items-center justify-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02] h-28 md:h-32 text-white/60">
                        <div className="text-sm">+ Aggiungi</div>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ✅ overlay loading (vale per mobile + desktop) */}
          {loading && LOADING_UI === "overlay" ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/35 backdrop-blur-md rounded-3xl">
              <div className="w-[92%] max-w-xl rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.65)]">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm text-white/85">Analisi in corso…</div>
                  <div className="text-xs text-white/50 tabular-nums">
                    {progress}%
                  </div>
                </div>
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-white/35 transition-[width] duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex flex-col md:flex-row gap-3">
            <div className="w-full">
              <textarea
                value={notes}
                onChange={(e) =>
                  setNotes(e.target.value.slice(0, NOTES_MAX_CHARS))
                }
                placeholder="Note (opzionale) es: cosa vuoi controllare nello specifico…"
                className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/85 outline-none placeholder:text-white/30 focus:border-white/20"
                rows={2}
                disabled={loading}
              />
              <div className="mt-1 text-[11px] text-white/35">
                Note: <span className="tabular-nums">{notes.length}</span>/
                <span className="tabular-nums">{NOTES_MAX_CHARS}</span>
              </div>
            </div>

            <button
              disabled={loading || files.length === 0}
              onClick={submit}
              className="h-[48px] md:w-[180px] inline-flex items-center justify-center gap-2 rounded-full border border-white/12 bg-white/10 px-5 text-sm text-white/90 backdrop-blur hover:bg-white/15 disabled:opacity-50"
              type="button"
            >
              {loading ? "Analizzo…" : "Esegui →"}
            </button>
          </div>

          <div className="mt-3 space-y-2">
            {remaining != null ? (
              <div className="text-[11px] text-white/35">
                Remaining today:{" "}
                <span className="text-white/70 tabular-nums">{remaining}</span>
              </div>
            ) : null}

            {softHint ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.06] px-3 py-2 text-[11px] text-white/70">
                {softHint}
              </div>
            ) : null}

            {quotaHint ? (
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200/90">
                {quotaHint}
              </div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200/90">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        {/* RISULTATI */}
        <div className="relative mt-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-white/80">Risultati</div>

            {result ? (
              <div className="text-[11px] text-white/40">
                Score:{" "}
                <span className="text-white/75 font-semibold tabular-nums">
                  {scoreTarget}%
                </span>
              </div>
            ) : null}
          </div>

          {!result && !loading ? (
            <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/45">
              {files.length === 0
                ? "Carica 1–4 foto per iniziare."
                : "Premi Esegui per avviare l’analisi."}
            </div>
          ) : null}

          {result ? (
            <div className="mt-3">
              <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3">
                  <div>
                    <div className="text-[11px] text-white/45">Quality score</div>
                    <div className="mt-1 text-4xl md:text-5xl font-semibold text-white tabular-nums">
                      {scoreAnim}
                      <span className="text-white/40 text-xl md:text-2xl">
                        /100
                      </span>
                    </div>
                  </div>

                  <div className="text-sm md:text-xs text-white/55 md:max-w-[58%] md:text-right leading-snug">
                    {result.summary}
                  </div>
                </div>

                <div className="mt-4 relative h-3 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="absolute inset-0"
                    style={{
                      background: GRADIENT,
                      clipPath: clipFill,
                      WebkitClipPath: clipFill,
                      transition:
                        "clip-path 700ms cubic-bezier(0.2,0.8,0.2,1)",
                      willChange: "clip-path",
                    }}
                  />
                  <div className="pointer-events-none absolute inset-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" />
                </div>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-3xl border border-emerald-400/20 bg-emerald-500/10 p-4">
                  <div className="text-xs tracking-[0.25em] text-emerald-200/90">
                    PRO
                  </div>
                  <ul className="mt-2 space-y-2 text-sm text-emerald-100/90">
                    {pros.length ? (
                      pros.map((x, i) => (
                        <li key={i} className="leading-snug">
                          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-emerald-300/90" />
                          {x}
                        </li>
                      ))
                    ) : (
                      <li className="text-emerald-100/60">—</li>
                    )}
                  </ul>
                </div>

                <div className="rounded-3xl border border-rose-400/20 bg-rose-500/10 p-4">
                  <div className="text-xs tracking-[0.25em] text-rose-200/90">
                    CONTRO
                  </div>
                  <ul className="mt-2 space-y-2 text-sm text-rose-100/90">
                    {cons.length ? (
                      cons.map((x, i) => (
                        <li key={i} className="leading-snug">
                          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-rose-300/90" />
                          {x}
                        </li>
                      ))
                    ) : (
                      <li className="text-rose-100/60">—</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* ✅ MOBILE: bottom bar sticky “Aggiungi” */}
      <div
        className="md:hidden fixed left-0 right-0 z-[50]"
        style={{
          bottom: "calc(env(safe-area-inset-bottom) + 10px)",
        }}
      >
        <div className="mx-auto w-[calc(100%-24px)] max-w-[520px] rounded-[18px] border border-white/12 bg-[#0b0b0c]/55 backdrop-blur-xl px-4 py-3 shadow-[0_20px_70px_rgba(0,0,0,0.55)]">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-white/90">
                Aggiungi 1–4 foto
              </div>
              <div className="text-[11px] text-white/50 tabular-nums">
                {files.length}/{MAX_IMAGES} selezionate
              </div>
            </div>

            <button
              type="button"
              onClick={() => galleryRef.current?.click()}
              disabled={!canAddMore}
              className="shrink-0 h-11 rounded-full bg-white text-black px-5 text-sm font-semibold disabled:opacity-60"
            >
              Aggiungi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
