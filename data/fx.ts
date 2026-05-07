const FALLBACK_CNY_TO_EUR = 0.13603;

export async function getCnyToEurRate(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=CNY&to=EUR",
      { next: { revalidate: 3600 } }
    );

    if (!res.ok) return FALLBACK_CNY_TO_EUR;

    const data = (await res.json()) as { rates?: { EUR?: number } };
    const rate = data?.rates?.EUR;

    if (!rate || !Number.isFinite(rate) || rate <= 0) return FALLBACK_CNY_TO_EUR;

    return rate;
  } catch {
    return FALLBACK_CNY_TO_EUR;
  }
}
