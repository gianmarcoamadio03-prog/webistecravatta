import type { ReactNode } from "react";
import ParallaxDecor from "@/components/ParallaxDecor";

type Props = {
  id?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
  childrenWidth?: "normal" | "wide";
  decor?: "none" | "orbs" | "shapes";
  decorIntensity?: number;
};

export default function ParallaxSection({
  id,
  eyebrow,
  title,
  description,
  children,
  childrenWidth = "normal",
  decor = "orbs",          // ✅ default sicuro
  decorIntensity = 18,
}: Props) {
  return (
    <section id={id} className="cc-section ps-section">
      {decor !== "none" && (
        <ParallaxDecor
          intensity={decorIntensity}
          variant={decor === "shapes" ? "shapes" : "orbs"}
        />
      )}

      <div className="cc-section-wrap">
        <div className={`cc-container ${childrenWidth === "wide" ? "cc-container--wide" : ""}`}>
          <div className={`ps-header ${!eyebrow ? "ps-header--noEyebrow" : ""}`}>
            {eyebrow ? <div className="ps-eyebrow">{eyebrow}</div> : null}
            <h2 className="ps-title">{title}</h2>
            {description ? <p className="ps-desc">{description}</p> : null}
          </div>

          <div className="ps-body">{children}</div>
        </div>
      </div>
    </section>
  );
}
