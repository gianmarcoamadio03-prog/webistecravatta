"use client";

export default function VerifiedBadge({ size = 16 }: { size?: number }) {
  return (
    <span
      title="Verificato"
      aria-label="Verificato"
      className="inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
        <circle cx="12" cy="12" r="10" fill="rgb(59 130 246)" />
        <path
          d="M10.2 13.7 8.4 11.9a1 1 0 0 0-1.4 1.4l2.5 2.5a1 1 0 0 0 1.4 0l6-6a1 1 0 1 0-1.4-1.4l-5.3 5.3z"
          fill="white"
        />
      </svg>
    </span>
  );
}
