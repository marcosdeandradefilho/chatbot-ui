// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// Node.js (não Edge) para evitar bloqueios e poder usar parsers/headers à vontade
export const runtime = "nodejs";

/* ======================== Tipos ======================== */
type Item = {
  source: "openalex" | "scielo" | "lexml" | "s2" | "scholar";
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

type Result = { items: Item[]; error?: string; _debug?: string };

function email() {
  return process.env.CONTACT_MAIL || process.env.CONTACT_EMAIL || "";
}

function cleanClone<T>(v: T): T {
  // garante que só dados serializáveis vão para o JSON
  return JSON.parse(JSON.stringify(v));
}

function json(data: any, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function pickYearFromText(txt?: string): number | undefined {
  if (!txt) return undefined;
  const m = txt.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
}

/* ======================== OPENALEX ======================== */
async function fetchOpenAlex(q: string, limit: number): Promise<Result> {
  const mail = encodeURIComponent(email() || "contato@example.com");
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${mail}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `openalex_${r.status}`, _debug: url };

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
      extra: { cited_by_count: w?.cited_by_count, venue: w?.host_venue?.display_name },
    }));

    return { items, _debug: url };
  } catch (e: any) {
    return { items: [], error: `openalex_err_${e?.message || "x"}`, _debug: url };
  }
}

/* ======================== SCIELO ======================== */
/** Usa o endpoint oficial de busca; se 403, faz fallback para a rota pública sem /api/ */
async function fetchScielo(q: string, limit: number): Promise<Result> {
  const url1 = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;
  const url2 = `https://search.scielo.org/?q=${encodeURIComponent(
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

  const tryOnce = async (url: string) => {
    const r = await fetch(url, { headers: commonHeaders, cache: "no-store" });
    if (!r.ok) return { ok: false as const, status: r.status, url };
    return { ok: true as const, json: await r.json(), url };
  };

  try {
    // 1ª tentativa: /api/v1
    let t = await tryOnce(url1);
    if (!t.ok) {
      // fallback: sem /api/
      t = await tryOnce(url2);
      if (!t.ok) return { items: [], error: `scielo_${t.status}`, _debug: t.url };
    }

    const j: any = t.json;
    const docs = j?.documents ?? j?.results ?? [];

    const items: Item[] = docs.slice(0, limit).map((d: any) => ({
      source: "scielo",
      title: d?.title ?? d?.document?.title ?? "",
      url: d?.link ?? d?.url ?? "",
      year: Number(d?.year) || pickYearFromText(d?.source) || undefined,
      authors: (d?.authors ?? [])
        .map((a: any) => (typeof a === "string" ? a : a?.name))
        .filter(Boolean),
      snippet: d?.snippet || d?.content,
      extra: { source: d?.source, journal: d?.journal },
    }));

    return { items, _debug: t.url };
  } catch (e: any) {
    return { items: [], error: `scielo_err_${e?.message || "x"}`, _debug: url1 };
  }
}

/* ======================== LEXML (SRU + MODS) ======================== */
/** Parser simples de MODS para título/URL/ano. */
function parseLexml(xml: string, limit: number): Item[] {
  const out: Item[] = [];
  const rec = /<record\b[\s\S]*?<\/record>/gi;
  let m: RegExpExecArray | null;
  while ((m = rec.exec(xml)) && out.length < limit) {
    const chunk = m[0];
    const title =
      chunk.match(/<mods:title>([\s\S]*?)<\/mods:title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const url =
      chunk.match(/<identifier[^>]*type="uri"[^>]*>([\s\S]*?)<\/identifier>/i)?.[1]?.trim() ||
      chunk.match(/<identifier[^>]*type="url"[^>]*>([\s\S]*?)<\/identifier>/i)?.[1]?.trim() ||
      "";
    const y = chunk.match(/<mods:dateIssued>(\d{4})/i)?.[1];
    if (title) out.push({ source: "lexml", title, url, year: y ? Number(y) : undefined });
  }
  return out;
}

/**
 * `lexmlKind` controla o tipo: "legislacao" | "doutrina" | "jurisprudencia" (default: "legislacao").
 * Ex.: ...&source=lexml&lexmlKind=jurisprudencia
 */
async function fetchLexml(q: string, limit: number, lexmlKind = "legislacao"): Promise<Result> {
  const base = (process.env.LEXML_SRU_URL || "https://servicos.lexml.gov.br/sru/").replace(
    /\/+$/,
    ""
  );
  const qFinal = `${q} ${lexmlKind}`.trim();
  const url = `${base}/?operation=searchRetrieve&version=1.2&recordSchema=mods&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(
    qFinal
  )}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/xml" },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `lexml_${r.status}`, _debug: url };

    const xml = await r.text();
    const items = parseLexml(xml, limit);
    return { items, _debug: url };
  } catch (e: any) {
    return { items: [], error: `lexml_err_${e?.message || "x"}`, _debug: url };
  }
}

/* ======================== SEMANTIC SCHOLAR (Graph API) ======================== */
/** OBS: usa **S2_API_KEY** (como você pediu), se definida. */
async function fetchSemanticScholar(q: string, limit: number): Promise<Result> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    q
  )}&limit=${limit}&fields=title,year,url,abstract,authors,name,venue`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.S2_API_KEY) {
    headers["x-api-key"] = process.env.S2_API_KEY!;
  }

  try {
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) return { items: [], error: `s2_${r.status}`, _debug: url };

    const j: any = await r.json();
    const data = j?.data ?? j?.papers ?? [];

    const items: Item[] = data.slice(0, limit).map((p: any) => ({
      source: "s2",
      title: p?.title ?? "",
      url: p?.url,
      year: Number(p?.year) || undefined,
      authors: (p?.authors ?? []).map((a: any) => a?.name).filter(Boolean),
      snippet: p?.abstract,
      extra: { venue: p?.venue },
    }));
    return { items, _debug: url };
  } catch (e: any) {
    return { items: [], error: `s2_err_${e?.message || "x"}`, _debug: url };
  }
}

/* ======================== GOOGLE SCHOLAR via SerpAPI ======================== */
async function fetchScholarSerp(q: string, limit: number): Promise<Result> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return { items: [], error: "scholar_missing_api_key", _debug: "SERPAPI_API_KEY" };

  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
    q
  )}&api_key=${encodeURIComponent(key)}&num=${limit}`;

  try {
    const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return { items: [], error: `scholar_${r.status}`, _debug: url };

    const j: any = await r.json();
    const rows = j?.organic_results ?? [];
    const items: Item[] = rows.slice(0, limit).map((it: any) => {
      const title = it?.title ?? "";
      const link = it?.link ?? it?.result_id;
      const sum = it?.publication_info?.summary || "";
      const yr = pickYearFromText(sum);
      let authors: string[] = [];
      if (it?.publication_info?.authors?.length) {
        authors = it.publication_info.authors.map((a: any) => a?.name).filter(Boolean);
      }
      return {
        source: "scholar",
        title,
        url: link,
        year: yr,
        authors,
        snippet: it?.snippet,
        extra: { summary: sum, cited_by: it?.inline_links?.cited_by?.total },
      };
    });

    return { items, _debug: url };
  } catch (e: any) {
    return { items: [], error: `scholar_err_${e?.message || "x"}`, _debug: url };
  }
}

/* ======================== HANDLER ======================== */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const src = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(10, Number(searchParams.get("limit")) || 5));
    const lexmlKind = (searchParams.get("lexmlKind") || "legislacao").toLowerCase();
    const debugOn = (searchParams.get("debug") || "") === "1";

    if (!q) return json({ ok: false, error: "missing_query", items: [] }, 400);

    const tasks: Promise<Result>[] = [];
    if (src === "all" || src === "openalex") tasks.push(fetchOpenAlex(q, limit));
    if (src === "all" || src === "scielo") tasks.push(fetchScielo(q, limit));
    if (src === "all" || src === "lexml") tasks.push(fetchLexml(q, limit, lexmlKind));
    if (src === "all" || src === "s2" || src === "semanticscholar") tasks.push(fetchSemanticScholar(q, limit));
    if (src === "all" || src === "scholar" || src === "serpapi") tasks.push(fetchScholarSerp(q, limit));

    if (tasks.length === 0) {
      return json({ ok: false, error: `unknown_source_${src}`, items: [] }, 400);
    }

    const results = await Promise.all(tasks);
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];
    const debugList = results.map((r) => r._debug).filter(Boolean);

    return json(
      cleanClone({
        ok: true,
        query: q,
        source: src,
        lexmlKind,
        count: items.length,
        errors,
        ...(debugOn ? { debug: debugList } : {}),
        items,
      })
    );
  } catch (e: any) {
    return json({ ok: false, error: `fatal_${e?.message || "unknown"}` }, 500);
  }
}
