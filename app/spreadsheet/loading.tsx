export default function LoadingSpreadsheet() {
  return (
    <div className="cc-sheet">
      <section className="cc-toolbar cc-glass cc-glass-panel">
        <div style={{ opacity: 0.6, fontSize: 12 }}>Caricamento catalogo…</div>
        <div style={{ marginTop: 10, height: 12, width: "40%", background: "rgba(255,255,255,.10)", borderRadius: 999 }} />
        <div style={{ marginTop: 8, height: 12, width: "25%", background: "rgba(255,255,255,.08)", borderRadius: 999 }} />
      </section>

      <div className="cc-grid" style={{ marginTop: 18 }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="cc-card cc-glass cc-glass-panel" style={{ height: 340 }} />
        ))}
      </div>
    </div>
  );
}
