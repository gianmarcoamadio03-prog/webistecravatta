"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

function cleanBackQuery(raw: string) {
  let q = (raw || "").trim();
  try {
    q = decodeURIComponent(q);
  } catch {}
  q = q.replace(/^\?/, "");

  if (!q) return "";
  if (q.includes("http://") || q.includes("https://")) return "";
  if (q.includes("/")) return "";
  return q;
}

export default function BackLinkClient({
  className,
}: {
  className: string;
}) {
  const sp = useSearchParams();
  const backRaw = sp.get("back") || "";
  const backQuery = cleanBackQuery(backRaw);
  const href = backQuery ? `/spreadsheet?${backQuery}` : "/spreadsheet";

  return (
    <Link href={href} className={className} title="Torna al catalogo">
      ← Catalogo
    </Link>
  );
}