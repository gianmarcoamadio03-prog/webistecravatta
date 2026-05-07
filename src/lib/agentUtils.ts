// src/lib/agentUtils.ts
// Unica fonte di verità per le funzioni agente condivise tra
// SpreadsheetClient, app/item/[slug]/page.tsx e qualsiasi futuro consumer.

import { toUsFansProductUrl, toMulebuyProductUrl } from "@/data/affiliate";

export type AgentItem = {
  source_url?: string;
  yupoo_url?: string;
  [key: string]: any;
};

export function isValidUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim());
}

export function safeStr(v: unknown): string {
  return (v ?? "").toString().trim();
}

export function findFirstSourceUrl(item: AgentItem): string {
  if (isValidUrl(item?.source_url)) return safeStr(item.source_url);
  if (isValidUrl(item?.yupoo_url))  return safeStr(item.yupoo_url);

  for (const v of Object.values(item)) {
    if (!isValidUrl(v)) continue;
    const s = (v as string).toLowerCase();
    if (
      s.includes("taobao.com") ||
      s.includes("tmall.com")  ||
      s.includes("weidian.com")
    ) return safeStr(v);
  }
  return "";
}

type Agent = "usfans" | "mulebuy";

export function getDirectAgentUrl(item: AgentItem, agent: Agent): string {
  const keys: string[] =
    agent === "usfans"
      ? ["usfans", "usfansLink", "usfans_link", "usfansUrl", "usfans_url"]
      : ["mulebuy", "mulebuyLink", "mulebuy_link", "mulebuyUrl", "mulebuy_url"];

  const domainCheck =
    agent === "usfans"
      ? (s: string) => s.includes("usfans.com")
      : (s: string) => s.includes("mulebuy.com");

  for (const k of keys) {
    const v = item?.[k];
    if (!isValidUrl(v)) continue;
    if (domainCheck((v as string).toLowerCase())) return safeStr(v);
  }
  for (const v of Object.values(item)) {
    if (!isValidUrl(v)) continue;
    if (domainCheck((v as string).toLowerCase())) return safeStr(v);
  }
  return "";
}

export function buildAgentUrl(item: AgentItem, agent: Agent): string {
  const direct = getDirectAgentUrl(item, agent);
  if (direct) return direct;

  const source = findFirstSourceUrl(item);
  if (!source) return "";

  return agent === "usfans"
    ? (toUsFansProductUrl(source) ?? "")
    : (toMulebuyProductUrl(source) ?? "");
}