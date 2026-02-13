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

  /** ✅ nuovo: dove mostrare il decor */
  decorMode?: "all" | "mobile" | "desktop";
};

export default function ParallaxSection({
  id,
  eyebrow,
  title,
  description,
  children,
  childrenWidth = "normal",
  decor = "orbs",
  decorIntensity = 18,
  decorMode = "all",
}: Props) {
  const decorVisibilityClass =
    decorMode === "mobile"
      ? "md:hidden"
      : decorMode === "desktop"
      ? "hidden md:block"
      : "";

  return (
    <section id={id} className="cc-section ps-section">
      {decor !== "none" && (
        <div className={decorVisibilityClass}>
          <ParallaxDecor
            intensity={decorIntensity}
            variant={decor === "shapes" ? "shapes" : "orbs"}
          />
        </div>
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
