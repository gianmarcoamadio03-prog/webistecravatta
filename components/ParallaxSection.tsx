// components/ParallaxSection.tsx
import "server-only";
import type { ReactNode } from "react";

type Props = {
  id?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
  childrenWidth?: "normal" | "wide";
};

export default function ParallaxSection({
  id,
  eyebrow,
  title,
  description,
  children,
  childrenWidth = "normal",
}: Props) {
  const hasEyebrow = !!eyebrow?.trim();
  const containerClass =
    childrenWidth === "wide" ? "cc-container cc-container--wide" : "cc-container";

  return (
    <section id={id} className="cc-section">
      <div className="cc-section-wrap">
        <div className={containerClass}>
          <header className={`ps-header ${hasEyebrow ? "" : "ps-header--noEyebrow"}`}>
            {hasEyebrow && <div className="ps-eyebrow">{eyebrow}</div>}
            <h2 className="ps-title">{title}</h2>
            {description ? <p className="ps-desc">{description}</p> : null}
          </header>

          {children}
        </div>
      </div>
    </section>
  );
}
