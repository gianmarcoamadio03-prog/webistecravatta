/**
 * Normalizzazione slug coerente tra client/server.
 *
 * - lower
 * - rimuove accenti
 * - converte tutto ciò che non è [a-z0-9] in "-"
 * - trim dei "-" ai lati
 */
export function normalizeSlug(input: unknown): string {
  const s = String(input ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
