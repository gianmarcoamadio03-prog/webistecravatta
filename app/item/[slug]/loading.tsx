export default function LoadingItem() {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 py-10">
      <div className="animate-pulse">
        <div className="h-8 w-64 rounded bg-white/10" />
        <div className="mt-3 h-4 w-80 rounded bg-white/10" />

        {/* ✅ main media 4/3 */}
        <div
          className="mt-8 w-full rounded-[22px] border border-white/10 bg-white/[0.04] overflow-hidden"
          style={{ aspectRatio: "4 / 3" }}
        />

        {/* thumbs */}
        <div className="mt-4 grid grid-cols-4 sm:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-[18px] border border-white/10 bg-white/[0.04]"
              style={{ aspectRatio: "1 / 1" }}
            />
          ))}
        </div>

        <div className="mt-8 flex gap-3">
          <div className="h-10 w-28 rounded-full bg-white/10" />
          <div className="h-10 w-28 rounded-full bg-white/10" />
        </div>
      </div>
    </div>
  );
}
