import Link from "next/link";

export default function TopLeftHome({
  href = "/",
  label = "Home",
}: {
  href?: string;
  label?: string;
}) {
  return (
    <div className="cc-topLeftNav">
      <Link href={href} className="cc-topLeftBtn" aria-label="Torna alla Home">
        <span className="cc-topLeftIcon" aria-hidden>
          ←
        </span>
        <span className="cc-topLeftText">{label}</span>
      </Link>
    </div>
  );
}
