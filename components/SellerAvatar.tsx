"use client";

import React, { useMemo, useState } from "react";

type Props = {
  name: string;
  src?: string;
  size?: number; // px
  className?: string;
};

function initial(name: string) {
  const s = String(name || "").trim();
  return (s[0] || "S").toUpperCase();
}

export default function SellerAvatar({ name, src, size = 40, className = "" }: Props) {
  const [broken, setBroken] = useState(false);

  const ring = useMemo(() => {
    // piccolo “carattere” visivo senza essere invadente
    return "ring-1 ring-white/15";
  }, []);

  const showImg = !!src && !broken;

  return (
    <div
      className={[
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full",
        "bg-white/6",
        ring,
        className,
      ].join(" ")}
      style={{ width: size, height: size }}
      aria-label={`Avatar seller ${name}`}
    >
      {/* glow soft */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(closest-side at 30% 30%, rgba(255,255,255,0.12), transparent 70%)",
        }}
      />

      {showImg ? (
        <img
          src={src}
          alt={name}
          className="relative h-full w-full object-cover"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="relative grid h-full w-full place-items-center">
          <div
            aria-hidden
            className="absolute inset-0 opacity-80"
            style={{
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03))",
            }}
          />
          <span className="relative text-sm font-semibold text-white/85">
            {initial(name)}
          </span>
        </div>
      )}
    </div>
  );
}