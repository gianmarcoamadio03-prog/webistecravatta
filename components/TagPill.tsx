"use client";

type Size = "sm" | "md";
type Variant = "auto" | "muted";

export default function TagPill({
  label,
  size = "sm",
  variant = "auto",
}: {
  label: string;
  size?: Size;
  variant?: Variant;
}) {
  const raw = String(label ?? "").trim();
  if (!raw) return null;

  const t = normalize(raw);

  const isCounter = raw.startsWith("+") || /^\+?\d+$/.test(raw);
  const v: Variant = isCounter ? "muted" : variant;

  const style = v === "muted" ? MUTED : pickStyle(t);

  const pad = size === "md" ? "px-3 py-1.5 text-[12px]" : "px-2.5 py-1 text-[11px]";
  const maxw = size === "md" ? "max-w-[220px]" : "max-w-[180px]";

  return (
    <span
      title={raw}
      className={[
        "inline-flex items-center gap-1.5 rounded-full border backdrop-blur",
        "leading-none select-none",
        pad,
        maxw,
        "truncate",
        style.wrap,
      ].join(" ")}
    >
      <span className={["h-1.5 w-1.5 rounded-full shrink-0", style.dot].join(" ")} />
      <span className="truncate">{raw}</span>
    </span>
  );
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 +_-]+/g, "");
}

type Style = { wrap: string; dot: string };

const MUTED: Style = {
  wrap: "border-white/12 bg-white/6 text-white/70",
  dot: "bg-white/35",
};

// ✅ stili “brand/category” (tutte classi esplicite per Tailwind)
const STYLES: Array<{ test: (t: string) => boolean; style: Style }> = [
  { test: (t) => t.includes("sneaker"), style: { wrap: "border-sky-500/25 bg-sky-500/10 text-sky-100", dot: "bg-sky-400" } },
  { test: (t) => t.includes("lv") || t.includes("louis vuitton"), style: { wrap: "border-indigo-500/25 bg-indigo-500/10 text-indigo-100", dot: "bg-indigo-400" } },
  { test: (t) => t.includes("supreme"), style: { wrap: "border-rose-500/25 bg-rose-500/10 text-rose-100", dot: "bg-rose-400" } },
  { test: (t) => t.includes("stussy"), style: { wrap: "border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-100", dot: "bg-fuchsia-400" } },
  { test: (t) => t.includes("corteiz"), style: { wrap: "border-violet-500/25 bg-violet-500/10 text-violet-100", dot: "bg-violet-400" } },
  { test: (t) => t.includes("high quality"), style: { wrap: "border-emerald-500/25 bg-emerald-500/10 text-emerald-100", dot: "bg-emerald-400" } },
];

function pickStyle(t: string): Style {
  for (const r of STYLES) if (r.test(t)) return r.style;
  return { wrap: "border-white/12 bg-white/7 text-white/75", dot: "bg-white/35" };
}
