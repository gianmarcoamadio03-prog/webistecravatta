"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  title: string;
  id: string;
  slug: string;
  brand?: string;
  category?: string;
  seller?: string;
  rowNumber?: number | null;
  sourceUrl?: string;
};

const BLOCK_KEY = "__BLOCK_GALLERY_OPEN_UNTIL__";

function blockGalleryOpen(ms = 650) {
  try {
    (window as any)[BLOCK_KEY] = Date.now() + ms;
  } catch {}
}

function stopAll(e: any) {
  e?.stopPropagation?.();
  if (e?.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
}

export default function SupportButton(props: Props) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const canSend = useMemo(() => msg.trim().length >= 3 && !sending, [msg, sending]);

  useEffect(() => setMounted(true), []);

  // lock scroll quando modal aperto
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // ESC chiude
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send() {
    setErr(null);
    setSending(true);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...props,
          rowNumber: props.rowNumber ?? undefined,
          pageUrl: window.location.href,
          message: msg.trim(),
        }),
      });

      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) throw new Error(j?.error || "Invio fallito");

      setOpen(false);
      setMsg("");
      setToast("✅ L’assistenza è stata notificata.");
      window.setTimeout(() => setToast(null), 2600);
    } catch (e: any) {
      setErr(e?.message || "Errore");
    } finally {
      setSending(false);
    }
  }

  const modal = open ? (
    <div
      className="qc-modalBackdrop"
      role="dialog"
      aria-modal="true"
      onPointerDown={(e) => {
        blockGalleryOpen();
        stopAll(e);
        // chiude SOLO se clicchi sul backdrop (fuori dal box)
        if (e.target === e.currentTarget) setOpen(false);
      }}
      onClick={(e) => {
        blockGalleryOpen();
        stopAll(e);
      }}
    >
      <div
        className="qc-modal"
        onPointerDown={(e) => {
          blockGalleryOpen();
          stopAll(e);
        }}
        onClick={(e) => {
          blockGalleryOpen();
          stopAll(e);
        }}
      >
        <div className="qc-modalTitle">Segnala un problema</div>

        <div className="qc-modalSub">
          Articolo: <span className="qc-mono">{props.title}</span>
          {props.rowNumber ? (
            <>
              {" "}
              • Riga sheet: <span className="qc-mono">{props.rowNumber}</span>
            </>
          ) : null}
        </div>

        <textarea
          className="qc-textarea"
          placeholder="Descrivi il problema (link errato, prezzo mancante, foto sbagliate, ecc.)"
          value={msg}
          autoFocus
          onChange={(e) => setMsg(e.target.value)}
          onPointerDown={(e) => {
            blockGalleryOpen();
            stopAll(e);
          }}
          onClick={(e) => {
            blockGalleryOpen();
            stopAll(e);
          }}
        />

        {err ? <div className="qc-error">{err}</div> : null}

        <div
          className="qc-actions"
          onPointerDown={(e) => {
            blockGalleryOpen();
            stopAll(e);
          }}
          onClick={(e) => {
            blockGalleryOpen();
            stopAll(e);
          }}
        >
          <button
            type="button"
            className="qc-btn qc-btnGhost"
            onClick={(e) => {
              stopAll(e);
              setOpen(false);
            }}
            disabled={sending}
          >
            Annulla
          </button>

          <button
            type="button"
            className="qc-btn qc-btnPrimary"
            onClick={(e) => {
              stopAll(e);
              send();
            }}
            disabled={!canSend}
          >
            {sending ? "Invio..." : "Invia"}
          </button>
        </div>
      </div>

      <style jsx>{`
        .qc-modalBackdrop {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          background: rgba(0, 0, 0, 0.62);
          backdrop-filter: blur(10px);
        }
        .qc-modal {
          width: min(560px, 92vw);
          border-radius: 18px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(10, 10, 10, 0.78);
          padding: 16px;
          box-shadow: 0 30px 120px rgba(0, 0, 0, 0.7);
        }
        .qc-modalTitle {
          font-size: 16px;
          font-weight: 650;
          color: rgba(255, 255, 255, 0.92);
        }
        .qc-modalSub {
          margin-top: 6px;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.55);
        }
        .qc-mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
            "Courier New", monospace;
          color: rgba(255, 255, 255, 0.78);
        }
        .qc-textarea {
          margin-top: 12px;
          width: 100%;
          min-height: 110px;
          resize: vertical;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.04);
          color: rgba(255, 255, 255, 0.9);
          padding: 12px;
          outline: none;
        }
        .qc-textarea:focus {
          border-color: rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.05);
        }
        .qc-error {
          margin-top: 10px;
          font-size: 12px;
          color: rgba(255, 120, 120, 0.95);
          white-space: pre-wrap;
        }
        .qc-actions {
          margin-top: 12px;
          display: flex;
          justify-content: flex-end;
          gap: 10px;
        }
        .qc-btn {
          border-radius: 999px;
          padding: 10px 14px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.05);
          color: rgba(255, 255, 255, 0.9);
          cursor: pointer;
        }
        .qc-btn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .qc-btnGhost {
          background: rgba(255, 255, 255, 0.03);
        }
        .qc-btnPrimary {
          border-color: rgba(255, 255, 255, 0.14);
          background: linear-gradient(
            90deg,
            rgba(167, 139, 250, 0.85),
            rgba(110, 231, 183, 0.85)
          );
          color: rgba(0, 0, 0, 0.82);
          font-weight: 650;
        }
      `}</style>
    </div>
  ) : null;

  const toastEl = toast ? (
    <div className="qc-toast">
      {toast}
      <style jsx>{`
        .qc-toast {
          position: fixed;
          left: 50%;
          bottom: 18px;
          transform: translateX(-50%);
          z-index: 2147483647;
          padding: 10px 14px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(10, 10, 10, 0.78);
          color: rgba(255, 255, 255, 0.92);
          box-shadow: 0 20px 70px rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(10px);
        }
      `}</style>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className="it-agentbtn it-agentbtn--support"
        onPointerDownCapture={(e) => {
          blockGalleryOpen();
          stopAll(e);
        }}
        onClickCapture={(e) => {
          blockGalleryOpen();
          stopAll(e);
          setOpen(true);
        }}
      >
        <span className="it-agentbtn-logo" aria-hidden>
          🆘
        </span>
        <span className="it-agentbtn-text">Segnala un problema</span>
      </button>

      {/* Portal = modal SEMPRE sopra tutto */}
      {mounted ? createPortal(modal, document.body) : null}
      {mounted ? createPortal(toastEl, document.body) : null}

      <style jsx>{`
        .it-agentbtn--support {
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.03);
          transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
        }
        .it-agentbtn--support:hover {
          transform: translateY(-1px);
          background: rgba(255, 255, 255, 0.05);
          border-color: rgba(255, 255, 255, 0.16);
        }
      `}</style>
    </>
  );
}
