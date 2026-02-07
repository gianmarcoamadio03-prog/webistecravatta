"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Seller, SellerCard } from "@/data/sellersShared";
import { inferStoreType, toWhatsAppHref } from "@/data/sellersShared";

type Props = { sellers: Seller[]; cards: SellerCard[] };

function norm(s: string) {
  return (s ?? "").toString().trim().toLowerCase();
}

export default function SellersPageClient({ sellers, cards }: Props) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const sellersById = useMemo(
    () => new Map(sellers.map((s) => [s.id, s])),
    [sellers]
  );

  // cover derivata: prima immagine card per seller (utile per modal)
  const sellerCoverById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cards) {
      if (!c.seller_id) continue;
      if (m.has(c.seller_id)) continue;
      if (c.image) m.set(c.seller_id, c.image);
    }
    return m;
  }, [cards]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    sellers.forEach((s) => s.tags.forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sellers]);

  const filtered = useMemo(() => {
    const needle = norm(q);
    return sellers.filter((s) => {
      const matchesQ =
        !needle ||
        norm(s.name).includes(needle) ||
        norm(s.tags.join(" ")).includes(needle);

      const matchesTag = !tag || s.tags.includes(tag);
      return matchesQ && matchesTag;
    });
  }, [sellers, q, tag]);

  const openSeller = openId ? sellersById.get(openId) : undefined;
  const openCover = openId ? sellerCoverById.get(openId) : undefined;

  return (
    <div className="w-full">
      {/* CAROUSEL */}
      <div className="sheet-ctaRow">
        <div className="text-sm text-white/60">Selezione del mese</div>
      </div>

      {cards.length === 0 ? (
        <div className="mt-6 text-center text-white/55">
          Nessuna “Selezione del mese” disponibile (tab <b>seller_cards</b> vuoto).
        </div>
      ) : (
        <SellerCardsCarousel
          cards={cards}
          sellersById={sellersById}
          onOpen={(sellerId) => setOpenId(sellerId)}
        />
      )}

      {/* LISTA + SEARCH */}
      <div className="mt-10 w-full max-w-5xl mx-auto">
        <div className="flex flex-col gap-3 items-center">
          <div className="w-full flex flex-col sm:flex-row gap-3">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cerca seller o tag…"
              className="w-full h-12 rounded-full px-5 bg-white/5 border border-white/15 text-white/90 outline-none focus:border-white/30"
            />

            <button
              type="button"
              onClick={() => {
                setQ("");
                setTag(null);
              }}
              className="h-12 px-5 rounded-full bg-white/6 border border-white/15 text-white/80 hover:bg-white/9"
            >
              Reset
            </button>
          </div>

          {/* TAG CHIPS */}
          <div className="w-full flex flex-wrap gap-2 justify-center mt-2">
            <Chip active={!tag} onClick={() => setTag(null)} label="Tutti" />
            {allTags.map((t) => (
              <Chip
                key={t}
                active={tag === t}
                onClick={() => setTag(tag === t ? null : t)}
                label={t}
              />
            ))}
          </div>
        </div>

        {/* RIGHE SELLER */}
        <div className="mt-8 space-y-3">
          {filtered.map((s) => (
            <SellerRow key={s.id} s={s} onOpen={() => setOpenId(s.id)} />
          ))}

          {filtered.length === 0 && (
            <div className="mt-10 text-center text-white/55">
              Nessun seller trovato. Controlla i tab <b>sellers</b> e <b>seller_cards</b> nel Google Sheet.
            </div>
          )}
        </div>
      </div>

      {/* MODAL */}
      {openSeller && (
        <SellerModal
          seller={openSeller}
          cover={openCover}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "h-9 px-4 rounded-full border text-sm",
        active
          ? "bg-white/14 border-white/30 text-white"
          : "bg-white/6 border-white/15 text-white/75 hover:bg-white/9",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/** =========================
 *  CAROUSEL (drag + wheel safe)
 *  ========================= */
function SellerCardsCarousel({
  cards,
  sellersById,
  onOpen,
}: {
  cards: SellerCard[];
  sellersById: Map<string, Seller>;
  onOpen: (sellerId: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const movedRef = useRef(false);
  const downRef = useRef(false);
  const startXRef = useRef(0);
  const startLeftRef = useRef(0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;

      downRef.current = true;
      movedRef.current = false;
      setDragging(true);

      startXRef.current = e.clientX;
      startLeftRef.current = el.scrollLeft;

      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
    };

    const onMove = (e: PointerEvent) => {
      if (!downRef.current) return;
      const dx = e.clientX - startXRef.current;
      if (Math.abs(dx) > 6) movedRef.current = true;
      el.scrollLeft = startLeftRef.current - dx;
    };

    const onUp = () => {
      downRef.current = false;
      setDragging(false);
      setTimeout(() => (movedRef.current = false), 0);
    };

    const onWheel = (e: WheelEvent) => {
      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      const wantsHorizontal = absX > absY || e.shiftKey;
      if (!wantsHorizontal) return;

      e.preventDefault();
      el.scrollLeft += absX > 0 ? e.deltaX : e.deltaY;
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel as any);
    };
  }, []);

  return (
    <div className="sheet-preview seller-cards">
      <div
        ref={scrollerRef}
        className={`sheet-preview-scroller ${dragging ? "is-dragging" : ""}`}
        style={{ touchAction: "pan-y" }}
        aria-label="Carousel best sellers"
      >
        <div className="sheet-preview-track">
          {cards.map((c) => {
            const seller = sellersById.get(c.seller_id);
            const img = c.image || "";
            const wa = toWhatsAppHref(seller?.whatsapp);
            const storeType = inferStoreType(seller?.store_url);
            const desc = (c.description ?? (c as any).subtitle ?? "").toString().trim();

            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (movedRef.current) return;
                  onOpen(c.seller_id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(c.seller_id);
                  }
                }}
                className="sheet-card text-left cursor-pointer focus:outline-none"
              >
                <div className="sheet-card-media">
                  {img ? (
                    <img src={img} alt={c.title} loading="lazy" />
                  ) : (
                    <div className="w-full h-full bg-white/5" />
                  )}
                </div>

                <div className="sheet-card-overlay" />

                <div className="sheet-card-meta">
                  <div className="sheet-badge">BEST SELLER</div>

                  <div>
                    <div className="sheet-title">{c.title}</div>

                    {desc ? (
                      <div className="mt-2 text-[13px] leading-snug text-white/70 line-clamp-3">
                        {desc}
                      </div>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-2 sheet-card-actions">
                      {seller?.store_url && (
                        <a
                          href={seller.store_url}
                          target="_blank"
                          rel="noreferrer"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          className="sc-btn"
                        >
                          {storeType === "weidian"
                            ? "Weidian"
                            : storeType === "taobao"
                            ? "Taobao"
                            : "Store"}
                        </a>
                      )}

                      {wa && (
                        <a
                          href={wa}
                          target="_blank"
                          rel="noreferrer"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          className="sc-btn"
                        >
                          WhatsApp
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                <style jsx>{`
                  .sc-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    height: 40px;
                    padding: 0 14px;
                    border-radius: 9999px;
                    border: 1px solid rgba(255, 255, 255, 0.14);
                    background: rgba(255, 255, 255, 0.06);
                    color: rgba(255, 255, 255, 0.88);
                    backdrop-filter: blur(10px);
                    transition: transform 160ms ease, background 160ms ease,
                      border-color 160ms ease;
                    white-space: nowrap;
                  }
                  .sc-btn:hover {
                    transform: translateY(-1px);
                    background: rgba(255, 255, 255, 0.09);
                    border-color: rgba(255, 255, 255, 0.22);
                  }
                `}</style>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** =========================
 *  LIST ROW
 *  ========================= */
function SellerRow({ s, onOpen }: { s: Seller; onOpen: () => void }) {
  const wa = toWhatsAppHref(s.whatsapp);
  const storeType = inferStoreType(s.store_url);

  return (
    <div className="rounded-3xl border border-white/12 bg-white/5 backdrop-blur-md px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="min-w-0">
          <div className="text-lg font-semibold text-white/95">{s.name}</div>

          {s.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {s.tags.map((t) => (
                <span
                  key={t}
                  className="text-xs px-3 py-1 rounded-full border border-white/12 bg-white/6 text-white/70"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onOpen} className="action-btn">
            Apri
          </button>

          {wa && (
            <a className="action-btn" href={wa} target="_blank" rel="noreferrer">
              WhatsApp
            </a>
          )}

          {s.store_url && (
            <a className="action-btn" href={s.store_url} target="_blank" rel="noreferrer">
              {storeType === "weidian"
                ? "Weidian"
                : storeType === "taobao"
                ? "Taobao"
                : "Store"}
            </a>
          )}

          {s.yupoo_url && (
            <a className="action-btn" href={s.yupoo_url} target="_blank" rel="noreferrer">
              Yupoo
            </a>
          )}
        </div>
      </div>

      <style jsx>{`
        .action-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 44px;
          padding: 0 16px;
          border-radius: 9999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(10px);
          transition: transform 160ms ease, background 160ms ease,
            border-color 160ms ease;
          white-space: nowrap;
        }
        .action-btn:hover {
          transform: translateY(-1px);
          background: rgba(255, 255, 255, 0.09);
          border-color: rgba(255, 255, 255, 0.22);
        }
      `}</style>
    </div>
  );
}

/** =========================
 *  MODAL (esc + lock scroll + autofocus)
 *  ========================= */
function SellerModal({
  seller,
  cover,
  onClose,
}: {
  seller: Seller;
  cover?: string;
  onClose: () => void;
}) {
  const wa = toWhatsAppHref(seller.whatsapp);
  const storeType = inferStoreType(seller.store_url);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    setTimeout(() => panelRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Dettagli seller ${seller.name}`}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-md"
        onClick={onClose}
        aria-label="Chiudi modal"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full max-w-2xl rounded-[32px] border border-white/12 bg-white/6 backdrop-blur-xl overflow-hidden shadow-2xl outline-none"
      >
        {cover ? (
          <div className="h-56 w-full overflow-hidden">
            <img
              src={cover}
              alt={seller.name}
              className="h-full w-full object-cover opacity-95"
            />
          </div>
        ) : null}

        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-2xl font-semibold text-white/95">{seller.name}</div>

              {seller.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {seller.tags.map((t) => (
                    <span
                      key={t}
                      className="text-xs px-3 py-1 rounded-full border border-white/12 bg-white/6 text-white/70"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-full bg-white/6 border border-white/15 text-white/80 hover:bg-white/10"
            >
              Chiudi
            </button>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            {seller.yupoo_url && (
              <a className="action-btn" href={seller.yupoo_url} target="_blank" rel="noreferrer">
                Yupoo
              </a>
            )}
            {wa && (
              <a className="action-btn" href={wa} target="_blank" rel="noreferrer">
                WhatsApp
              </a>
            )}
            {seller.store_url && (
              <a className="action-btn" href={seller.store_url} target="_blank" rel="noreferrer">
                {storeType === "weidian"
                  ? "Weidian"
                  : storeType === "taobao"
                  ? "Taobao"
                  : "Store"}
              </a>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        .action-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 44px;
          padding: 0 16px;
          border-radius: 9999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(10px);
          transition: transform 160ms ease, background 160ms ease,
            border-color 160ms ease;
        }
        .action-btn:hover {
          transform: translateY(-1px);
          background: rgba(255, 255, 255, 0.09);
          border-color: rgba(255, 255, 255, 0.22);
        }
      `}</style>
    </div>
  );
}
