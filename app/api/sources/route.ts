// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// força execução no server e evita cache estático
export const dynamic = "force-dynamic";
// usar Node.js (não Edge) para evitar limitações de rede/parsers
export const runtime = "nodejs";

type Item = {
  source: "openalex" | "scielo" | "lexml" | "s2" | "scholar";
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

function email() {
  return process.env.CONTACT_MAIL || process.env.CONTACT_EMAIL || "";
}

function cleanClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/* =====================================
   OpenAlex
   ===================================== */
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

/* =====================================
   SciELO (API pública de busca)
   ===================================== */
async function fetchScielo(q: string, limit: number) {
  const url = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const headers = {
    Accept: "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "User-Agent": ua,
    Referer: "https://search.scielo.org/",
  } as const;

  try {
    // tentativa principal
    let r = await fetch(url, { headers, cache: "no-store" });

    // fallback se 403 em alguns PoPs
    if (r.status === 403) {
      const fb = `https://search.scielo.org/?q=${encodeURIComponent(
        q
      )}&lang=pt&count=${limit}&format=json`;
      r = await fetch(fb, { headers, cache: "no-store" });
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

/* =====================================
   LexML (SRU + MODS)
   ===================================== */
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
    // HTTPS
    let r = await fetch(`https://${base}`, { headers, cache: "no-store" });

    // fallback HTTP
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

/* =====================================
   Semantic Scholar (Graph API v1)
   ===================================== */
async function fetchSemanticScholar(q: string, limit: number) {
  const base = "https://api.semanticscholar.org/graph/v1";
  const fields = [
    "title",
    "year",
    "url",
    "abstract",
    "authors.name",
    "externalIds",
  ].join(",");
  const url = `${base}/paper/search?query=${encodeURIComponent(
    q
  )}&limit=${limit}&fields=${fields}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  // se tiver chave, envia
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  }

  try {
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return { items: [] as Item[], error: `s2_${r.status}` };

    const j: any = await r.json();
    const data = j?.data ?? j?.papers ?? [];

    const items: Item[] = data.map((p: any) => ({
      source: "s2",
      title: p?.title ?? "",
      url: p?.url ?? "",
      year: Number(p?.year) || undefined,
      authors: (p?.authors ?? []).map((a: any) => a?.name).filter(Boolean),
      snippet: p?.abstract,
      extra: { externalIds: p?.externalIds },
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `s2_err_${e?.message || "x"}` };
  }
}

/* =====================================
   Google Scholar via SerpAPI
   ===================================== */
async function fetchGoogleScholar(q: string, limit: number) {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    // sem chave não dá pra usar SerpAPI
    return { items: [] as Item[], error: "scholar_missing_api_key" };
  }

  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
    q
  )}&num=${limit}&api_key=${apiKey}`;

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return { items: [] as Item[], error: `scholar_${r.status}` };

    const j: any = await r.json();
    const results = j?.organic_results ?? [];

    const items: Item[] = results.slice(0, limit).map((d: any) => {
      const pub = d?.publication_info?.summary || "";
      const year = Number((pub.match(/(19|20)\d{2}/) || [])[0]) || undefined;
      // autores aparecem misturados na summary; melhor não inventar muito
      return {
        source: "scholar",
        title: d?.title ?? "",
        url: d?.link ?? "",
        year,
        authors: undefined,
        snippet: d?.snippet ?? pub,
        extra: {
          cited_by: d?.inline_links?.cited_by?.total ?? undefined,
        },
      };
    });

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `scholar_err_${e?.message || "x"}` };
  }
}

/* =====================================
   Handler
   ===================================== */
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
    if (src === "all" || src === "s2" || src === "semanticscholar") tasks.push(fetchSemanticScholar(q, limit));
    if (src === "all" || src === "scholar" || src === "google_scholar") tasks.push(fetchGoogleScholar(q, limit));

    const results = await Promise.all(tasks);
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];

    return NextResponse.json(
      { ok: true, query: q, source: src, count: items.length, errors, items: cleanClone(items) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `fatal_${e?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
