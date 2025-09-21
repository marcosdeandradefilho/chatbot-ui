// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Garante que esta rota sempre rode no servidor e sem cache estático
export const dynamic = "force-dynamic";
// Usamos Node.js (não Edge) para evitar limitações de rede/parsers
export const runtime = "nodejs";

type Item = {
  source: "openalex" | "scielo" | "lexml";
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

function email() {
  // você já definiu CONTACT_MAIL na Vercel
  return process.env.CONTACT_MAIL || process.env.CONTACT_EMAIL || "";
}

function cleanClone<T>(v: T): T {
  // garante que só dados serializáveis vão para o JSON
  return JSON.parse(JSON.stringify(v));
}

/* =========================
   OpenAlex
   ========================= */
async function fetchOpenAlex(q: string, limit: number) {
  const mail = encodeURIComponent(email() || "contato@example.com");
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${mail}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return { items: [] as Item[], error: `openalex_${r.status}` };

    const j: any = await r.json();
    const items: Item[] = (j?.results ?? []).map((w: any) => ({
      source: "openalex",
      title: w?.title ?? "",
      url: w?.id ?? w?.host_venue?.url ?? "",
      year: Number(w?.publication_year) || undefined,
      authors:
        (w?.authorships ?? [])
          .map((a: any) => a?.author?.display_name)
          .filter(Boolean) || [],
      snippet: w?.abstract_inverted_index
        ? Object.keys(w.abstract_inverted_index).slice(0, 30).join(" ")
        : undefined,
      extra: { cited_by_count: w?.cited_by_count },
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `openalex_err_${e?.message || "x"}` };
  }
}

/* =========================
   SciELO (API pública de busca)
   ========================= */
async function fetchScielo(q: string, limit: number) {
  const url = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const commonHeaders = {
    Accept: "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "User-Agent": ua,
    Referer: "https://search.scielo.org/",
  } as const;

  try {
    // Tentativa principal
    let r = await fetch(url, { headers: commonHeaders, cache: "no-store" });

    // Fallback se tomar 403 (alguns pops pedem outro endpoint)
    if (r.status === 403) {
      const fallback = `https://search.scielo.org/?q=${encodeURIComponent(
        q
      )}&lang=pt&count=${limit}&format=json`;
      r = await fetch(fallback, { headers: commonHeaders, cache: "no-store" });
    }

    if (!r.ok) return { items: [] as Item[], error: `scielo_${r.status}` };

    const j: any = await r.json();
    const docs = j?.documents ?? j?.results ?? [];

    const items: Item[] = docs.slice(0, limit).map((d: any) => ({
      source: "scielo",
      title: d?.title ?? d?.document?.title ?? "",
      url: d?.link ?? d?.url ?? "",
      year: Number(d?.year) || undefined,
      authors: (d?.authors ?? [])
        .map((a: any) => (typeof a === "string" ? a : a?.name))
        .filter(Boolean),
      snippet: d?.snippet || d?.content,
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `scielo_err_${e?.message || "x"}` };
  }
}

/* =========================
   LexML (SRU + MODS)
   ========================= */
function parseLexml(xml: string, limit: number): Item[] {
  const out: Item[] = [];
  const rec = /<record\b[\s\S]*?<\/record>/gi;
  let m: RegExpExecArray | null;
  while ((m = rec.exec(xml)) && out.length < limit) {
    const chunk = m[0];
    const title =
      chunk.match(/<mods:title>(.*?)<\/mods:title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const url =
      chunk.match(/<identifier[^>]*type="uri"[^>]*>(.*?)<\/identifier>/i)?.[1] ||
      chunk.match(/<identifier[^>]*type="url"[^>]*>(.*?)<\/identifier>/i)?.[1] ||
      "";
    const y = chunk.match(/<mods:dateIssued>(\d{4})/i)?.[1];
    if (title) out.push({ source: "lexml", title, url, year: y ? Number(y) : undefined });
  }
  return out;
}

async function fetchLexml(q: string, limit: number) {
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const headers = {
    Accept: "application/xml",
    "User-Agent": ua,
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  } as const;

  const base = `servicos.lexml.gov.br/sru/?operation=searchRetrieve&version=1.2&recordSchema=mods&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(
    q
  )}`;

  try {
    // 1ª tentativa: HTTPS
    let r = await fetch(`https://${base}`, { headers, cache: "no-store" });

    // Fallback se status ruim: tentar HTTP
    if (!r.ok) {
      try {
        r = await fetch(`http://${base}`, { headers, cache: "no-store" });
      } catch {}
    }

    if (!r.ok) return { items: [] as Item[], error: `lexml_${r.status}` };

    const xml = await r.text();
    return { items: parseLexml(xml, limit) };
  } catch (e: any) {
    return { items: [] as Item[], error: `lexml_err_${e?.message || "x"}` };
  }
}

/* =========================
   Handler
   ========================= */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const src = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(10, Number(searchParams.get("limit")) || 5));

    if (!q)
      return NextResponse.json(
        { ok: false, error: "missing_query", items: [] },
        { status: 400 }
      );

    const tasks: Promise<{ items: Item[]; error?: string }>[] = [];
    if (src === "all" || src === "openalex") tasks.push(fetchOpenAlex(q, limit));
    if (src === "all" || src === "scielo") tasks.push(fetchScielo(q, limit));
    if (src === "all" || src === "lexml") tasks.push(fetchLexml(q, limit));

    const results = await Promise.all(tasks);
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];

    return NextResponse.json(
      { ok: true, query: q, source: src, count: items.length, errors, items: cleanClone(items) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    // Nunca mostra tela branca; sempre responde JSON
    return NextResponse.json(
      { ok: false, error: `fatal_${e?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
