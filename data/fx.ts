const FALLBACK_CNY_TO_EUR = 0.13;

export async function getCnyToEurRate(): Promise<number> {
  try {
    // endpoint semplice e veloce: exchangerate.host
    const res = await fetch(
      "https://api.exchangerate.host/convert?from=CNY&to=EUR",
      {
        next: { revalidate: 3600 }, // ✅ cache server 1 ora
      }
    );

    if (!res.ok) return FALLBACK_CNY_TO_EUR;

    const data = (await res.json()) as { result?: number };
    const rate = typeof data?.result === "number" ? data.result : null;

    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      return FALLBACK_CNY_TO_EUR;
    }

    return rate;
  } catch {
    return FALLBACK_CNY_TO_EUR;
  }
}
