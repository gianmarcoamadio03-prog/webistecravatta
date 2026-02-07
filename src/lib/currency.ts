export const CNY_TO_EUR = 0.13603;

export function cnyToEur(cny: number): number {
  return Math.round(cny * CNY_TO_EUR * 100) / 100;
}

export function formatEUR(value: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(value);
}

/** prende "238" oppure "¥~238" oppure "CNY 238.50" e restituisce 238.5 */
export function parseCny(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input);
  const m = s.match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

