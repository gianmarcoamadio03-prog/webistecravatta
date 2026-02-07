export default function RootLoading() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: 240,
          borderRadius: 24,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(255,255,255,0.05)",
          boxShadow: "0 40px 140px rgba(0,0,0,0.55)",
          padding: 18,
          backdropFilter: "blur(18px)",
        }}
      >
        <div
          style={{
            height: 10,
            borderRadius: 999,
            background: "rgba(255,255,255,0.10)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "50%",
              borderRadius: 999,
              background:
                "linear-gradient(90deg, rgba(180,160,255,0.65), rgba(170,255,220,0.65))",
              animation: "cc-loading 0.9s ease-in-out infinite",
            }}
          />
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 12,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.55)",
            textAlign: "center",
          }}
        >
          Loading
        </div>
      </div>

      <style>{`
        @keyframes cc-loading {
          0% { transform: translateX(-70%); opacity: 0.55; }
          50% { opacity: 1; }
          100% { transform: translateX(170%); opacity: 0.55; }
        }
      `}</style>
    </div>
  );
}
