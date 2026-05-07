export default function LoadingSpreadsheet() {
  return (
    <div className="min-h-screen w-full">
      <div className="sticky top-0 z-50 border-b border-white/10 bg-black/55 backdrop-blur-xl">
        <div className="mx-auto w-full max-w-[1700px] px-4 sm:px-5 pt-3 pb-3 sm:pt-7 sm:pb-5">
          <div className="hidden sm:block">
            <div className="flex justify-center">
              <div className="h-11 w-full max-w-[780px] rounded-full bg-white/5 border border-white/10 animate-pulse" />
            </div>
            <div className="mt-4 flex justify-center gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-9 w-[190px] rounded-full bg-white/5 border border-white/10 animate-pulse" />
              ))}
            </div>
          </div>
          <div className="sm:hidden mx-auto w-full max-w-[520px]">
            <div className="h-10 w-full rounded-full bg-white/5 border border-white/10 animate-pulse" />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="h-10 rounded-full bg-white/5 border border-white/10 animate-pulse" />
              <div className="h-10 rounded-full bg-white/5 border border-white/10 animate-pulse" />
            </div>
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1700px] px-4 sm:px-5 pt-6 pb-14">
        <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
          {Array.from({ length: 42 }).map((_, i) => (
            <div key={i} className="rounded-3xl border border-white/10 bg-white/[0.04] overflow-hidden animate-pulse">
              <div className="w-full aspect-[4/3] bg-white/5" />
              <div className="p-3 space-y-2">
                <div className="h-4 w-3/4 rounded-full bg-white/5" />
                <div className="h-3 w-1/2 rounded-full bg-white/5" />
                <div className="mt-3 flex gap-2">
                  <div className="h-9 flex-1 rounded-full bg-white/5" />
                  <div className="h-9 flex-1 rounded-full bg-white/5" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
