// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// Node.js para evitar limitações de Edge (UA custom, etc.)
export const runtime = "nodejs";

// ---------- Tipos ----------
type SourceName =
  | "openalex"
  | "scielo"
  | "lexml"
  | "semanticscholar"
  | "serpapi_scholar"
  | "openai_web"
  | "perplexity";

type Item = {
  source: SourceName;
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

type TaskResult = { items: Item[]; error?: string };

// ---------- Helpers ----------
const EMAIL =
  process.env.CONTACT_MAIL ||
  process.env.CONTACT_EMAIL ||
  "contato@example.com";

const UA = `Mozilla/5.0 (compatible; ResearchBot/1.0; +mailto:${EMAIL})`;

function cleanClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
const asNum = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

const yearFromStr = (s?: string | null) => {
  const y = asNum(s);
  return y && y >= 1400 && y <= 3000 ? y : undefined;
};

// tenta extrair ano de um texto ("2018", " (2012)" etc.)
function sniffYear(s?: string): number | undefined {
  if (!s) return;
  const m = String(s).match(/\b(1[6-9]\d{2}|20\d{2}|2100)\b/);
  return m ? Number(m[0]) : undefined;
}

// --------- SOURCES ---------

// OpenAlex -------------------------------------------------------
async function fetchOpenAlex(q: string, limit: number): Promise<TaskResult> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${encodeURIComponent(EMAIL)}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `openalex_${r.status}` };
    const j: any = await r.json();

    const items: Item[] = (j?.results ?? []).slice(0, limit).map((w: any) => ({
      source: "openalex",
      title: w?.title ?? "",
      url:
        w?.primary_location?.landing_page_url ||
        w?.id ||
        (w?.doi ? `https://doi.org/${w.doi}` : undefined),
      year: asNum(w?.publication_year),
      authors:
        (w?.authorships ?? [])
          .map((a: any) => a?.author?.display_name)
          .filter(Boolean) || [],
      snippet: w?.abstract_inverted_index
        ? Object.keys(w.abstract_inverted_index).slice(0, 40).join(" ")
        : undefined,
      extra: { cited_by_count: w?.cited_by_count },
    }));

    return { items };
  } catch (e: any) {
    return { items: [], error: `openalex_err_${e?.message || "x"}` };
  }
}

// SciELO ---------------------------------------------------------
// 1ª tentativa: Search API pública (pode exigir UA/Referer). Se 403, tenta ArticleMeta.
async function fetchScielo(q: string, limit: number): Promise<TaskResult> {
  const api1 = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  const commonHeaders = {
    Accept: "application/json",
    "User-Agent": UA,
    Referer: "https://search.scielo.org/",
  } as Record<string, string>;

  try {
    const r = await fetch(api1, {
      headers: commonHeaders,
      cache: "no-store",
    });

    if (r.status === 403) {
      // fallback: ArticleMeta (menos estável para busca, mas vale tentar)
      const api2 = `https://articlemeta.scielo.org/api/v1/article/search/?q=${encodeURIComponent(
        q
      )}&limit=${limit}`;
      try {
        const r2 = await fetch(api2, {
          headers: commonHeaders,
          cache: "no-store",
        });
        if (!r2.ok) return { items: [], error: `scielo_${r2.status}` };
        const j2: any = await r2.json();
        const arr: any[] = j2?.objects ?? j2?.results ?? j2 ?? [];

        const items: Item[] = arr.slice(0, limit).map((d: any) => ({
          source: "scielo",
          title: d?.title || d?.document?.title || d?.article_title || "",
          url:
            d?.link ||
            d?.url ||
            d?.pid
              ? `https://www.scielo.br/scielo.php?script=sci_arttext&pid=${d.pid}`
              : undefined,
          year:
            asNum(d?.year) ||
            asNum(d?.publication_year) ||
            sniffYear(d?.publication_date),
          authors:
            (d?.authors ??
              d?.article_authors ??
              d?.author ??
              [])
              .map((a: any) =>
                typeof a === "string" ? a : a?.name || a?.full_name
              )
              .filter(Boolean) || [],
          snippet: d?.snippet || d?.abstract || d?.summary,
        }));
        return { items, error: "scielo_403" };
      } catch (e: any) {
        return { items: [], error: `scielo_fallback_err_${e?.message || "x"}` };
      }
    }

    if (!r.ok) return { items: [], error: `scielo_${r.status}` };
    const j: any = await r.json();
    const docs = j?.documents ?? j?.results ?? [];

    const items: Item[] = docs.slice(0, limit).map((d: any) => ({
      source: "scielo",
      title: d?.title ?? d?.document?.title ?? "",
      url: d?.link ?? d?.url ?? "",
      year: asNum(d?.year),
      authors: (d?.authors ?? [])
        .map((a: any) => (typeof a === "string" ? a : a?.name))
        .filter(Boolean),
      snippet: d?.snippet || d?.content,
    }));

    return { items };
  } catch (e: any) {
    return { items: [], error: `scielo_err_${e?.message || "x"}` };
  }
}

// LexML (SRU/DC) -------------------------------------------------
// Aceita filtros: term, tipo_documento, numero, ano (ou "2010-2015"),
// localidade, autoridade, excluir (palavras a NÃO conter).
function buildLexmlCQL(params: URLSearchParams, fallbackTerm?: string) {
  const term = (params.get("term") || fallbackTerm || "").trim();
  const tipo_documento = (params.get("tipo_documento") || "").trim();
  const numero = (params.get("numero") || "").trim();
  const ano = (params.get("ano") || "").trim();
  const localidade = (params.get("localidade") || "").trim();
  const autoridade = (params.get("autoridade") || "").trim();
  const excluir = (params.get("excluir") || "").trim();

  const parts: string[] = [];

  if (term) {
    const t = term.replace(/"/g, '\\"');
    parts.push(`(dc.title all "${t}" or dc.description all "${t}")`);
  }
  if (tipo_documento) {
    // aceita múltiplos separados por vírgula
    const tipos = tipo_documento
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tipos.length) {
      const ors = tipos
        .map((t) =>
          t.includes(" ")
            ? `facet-tipoDocumento all "${t}"`
            : `facet-tipoDocumento any "${t}"`
        )
        .join(" or ");
      parts.push(`(${ors})`);
    }
  }
  if (numero) {
    const n = numero.replace(/"/g, '\\"');
    parts.push(`(urn any "${n}" or dc.title any "${n}")`);
  }
  if (ano) {
    const a = ano.replace(/\s+/g, "");
    if (a.includes("-")) {
      const [ini, fim] = a.split("-");
      if (ini && fim) {
        parts.push(`(date >= "${ini}" and date <= "${fim}")`);
      }
    } else {
      parts.push(`date any "${a}"`);
    }
  }
  if (localidade) {
    const loc = localidade.replace(/"/g, '\\"');
    parts.push(loc.includes(" ") ? `localidade = "${loc}"` : `localidade any "${loc}"`);
  }
  if (autoridade) {
    const aut = autoridade.replace(/"/g, '\\"');
    parts.push(aut.includes(" ") ? `autoridade = "${aut}"` : `autoridade any "${aut}"`);
  }
  if (excluir) {
    const xs = excluir
      .split(/,|;/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (xs.length) {
      const clauses = xs.map((w) =>
        w.includes(" ")
          ? `dc.title all "${w}" or dc.description all "${w}"`
          : `dc.title any "${w}" or dc.description any "${w}"`
      );
      parts.push(`not (${clauses.join(" or ")})`);
    }
  }

  return parts.join(" and ");
}

function parseLexmlDC(xml: string, limit: number): Item[] {
  // parse simples por regex (suficiente p/ SRU DC)
  const recRe = /<srw:record\b[\s\S]*?<\/srw:record>/gi;
  const titleRe = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i;
  const descRe = /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i;
  const urnRe = /<urn[^>]*>([\s\S]*?)<\/urn>/i;

  const out: Item[] = [];
  let m: RegExpExecArray | null;
  while ((m = recRe.exec(xml)) && out.length < limit) {
    const chunk = m[0];
    const title =
      chunk.match(titleRe)?.[1]?.replace(/\s+/g, " ").trim() || "Sem título";
    const desc = chunk.match(descRe)?.[1]?.replace(/\s+/g, " ").trim();
    const urn = chunk.match(urnRe)?.[1]?.trim();
    const url = urn ? `https://www.lexml.gov.br/urn/${urn}` : undefined;

    out.push({
      source: "lexml",
      title,
      url,
      snippet: desc,
    });
  }
  return out;
}

async function fetchLexml(
  params: URLSearchParams,
  fallbackTerm: string,
  limit: number
): Promise<TaskResult> {
  const cql = buildLexmlCQL(params, fallbackTerm);
  if (!cql) return { items: [], error: "lexml_missing_query" };

  const base = "https://www.lexml.gov.br/busca/SRU";
  const url = `${base}?operation=searchRetrieve&version=1.1&recordSchema=dc&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(
    cql
  )}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/xml", "User-Agent": UA },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `lexml_${r.status}` };
    const xml = await r.text();
    return { items: parseLexmlDC(xml, limit) };
  } catch (e: any) {
    return { items: [], error: `lexml_err_${e?.message || "x"}` };
  }
}

// Semantic Scholar -----------------------------------------------
async function fetchSemanticScholar(
  q: string,
  limit: number
): Promise<TaskResult> {
  const key = process.env.S2_API_KEY; // <- corrigido!
  const fields =
    "title,authors,year,abstract,url,citationCount,externalIds,venue";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    q
  )}&limit=${limit}&fields=${encodeURIComponent(fields)}`;

  try {
    const r = await fetch(url, {
      headers: key
        ? { "x-api-key": key, Accept: "application/json", "User-Agent": UA }
        : { Accept: "application/json", "User-Agent": UA },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `s2_${r.status}` };
    const j: any = await r.json();

    const items: Item[] = (j?.data ?? []).slice(0, limit).map((p: any) => ({
      source: "semanticscholar",
      title: p?.title ?? "",
      url:
        p?.url ||
        (p?.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : undefined),
      year: asNum(p?.year),
      authors:
        (p?.authors ?? [])
          .map((a: any) => a?.name)
          .filter(Boolean) || [],
      snippet: p?.abstract
        ? String(p.abstract).slice(0, 500)
        : undefined,
      extra: { citationCount: p?.citationCount, venue: p?.venue },
    }));

    return { items };
  } catch (e: any) {
    return { items: [], error: `s2_err_${e?.message || "x"}` };
  }
}

// SerpAPI - Google Scholar ---------------------------------------
async function fetchSerpapiScholar(
  q: string,
  limit: number
): Promise<TaskResult> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return { items: [], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
    q
  )}&hl=pt&num=${limit}&api_key=${key}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
    if (!r.ok) return { items: [], error: `serpapi_${r.status}` };
    const j: any = await r.json();

    const results: any[] = j?.organic_results ?? [];
    const items: Item[] = results.slice(0, limit).map((res: any) => {
      const pub = res?.publication_info?.summary || "";
      return {
        source: "serpapi_scholar",
        title: res?.title || "",
        url: res?.link || res?.result_id || res?.resources?.[0]?.link,
        year: sniffYear(pub),
        authors:
          (res?.publication_info?.authors ?? []).map((a: any) => a?.name).filter(Boolean) ||
          undefined,
        snippet: res?.snippet || res?.inline_links?.cited_by?.summary,
      };
    });

    return { items };
  } catch (e: any) {
    return { items: [], error: `serpapi_err_${e?.message || "x"}` };
  }
}

// SerpAPI - Web (usado como "openai_web") -------------------------
async function fetchSerpapiWeb(q: string, limit: number): Promise<TaskResult> {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) return { items: [], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    q
  )}&hl=pt&num=${limit}&api_key=${key}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, cache: "no-store" });
    if (!r.ok) return { items: [], error: `serpapi_${r.status}` };
    const j: any = await r.json();

    const results: any[] = j?.organic_results ?? [];
    const items: Item[] = results.slice(0, limit).map((res: any) => ({
      source: "openai_web",
      title: res?.title || res?.displayed_link || "",
      url: res?.link,
      snippet: res?.snippet,
    }));

    return { items };
  } catch (e: any) {
    return { items: [], error: `serpapi_err_${e?.message || "x"}` };
  }
}

// Perplexity ------------------------------------------------------
async function fetchPerplexity(q: string, limit: number): Promise<TaskResult> {
  const key =
    process.env.PPLX_API_KEY ||
    process.env.PERPLEXITY_API_KEY ||
    process.env.PPLX_APIKEY;
  if (!key) return { items: [], error: "perplexity_missing_key" };

  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar-small-online",
    temperature: 0,
    top_p: 1,
    return_citations: true,
    messages: [{ role: "user", content: `Retorne até ${limit} fontes com links sobre: ${q}` }],
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) return { items: [], error: `perplexity_${r.status}` };
    const j: any = await r.json();

    // Perplexity pode devolver "citations" no topo ou dentro de choices[0].message
    const cits: string[] =
      j?.citations ||
      j?.choices?.[0]?.message?.citations ||
      [];

    // Se não vier citations, tente extrair URLs do texto
    let urls: string[] = cits;
    if (!urls?.length) {
      const txt: string =
        j?.choices?.[0]?.message?.content || "";
      urls = (txt.match(/https?:\/\/[^\s\]\)]+/gi) || []).slice(0, limit);
    }

    const items: Item[] = (urls || []).slice(0, limit).map((u: string) => ({
      source: "perplexity",
      title: new URL(u).hostname,
      url: u,
    }));

    return { items };
  } catch (e: any) {
    return { items: [], error: `perplexity_err_${e?.message || "x"}` };
  }
}

// ---------- Handler ----------
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    // aceita q OU term (para compatibilidade com LexML)
    const qRaw = (searchParams.get("q") || searchParams.get("term") || "").trim();
    const src = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(10, asNum(searchParams.get("limit")) || 5));

    if (!qRaw && src !== "lexml") {
      // LexML pode ser acionado com filtros mesmo que 'term' esteja ausente (p.ex. numero/ano)
      return NextResponse.json(
        { ok: false, error: "missing_query", items: [] },
        { status: 400 }
      );
    }

    const tasks: Promise<TaskResult>[] = [];

    // Escolha de fontes
    const push = (fn: Promise<TaskResult>) => tasks.push(fn);

    if (src === "all" || src === "openalex") push(fetchOpenAlex(qRaw, limit));
    if (src === "all" || src === "semanticscholar") push(fetchSemanticScholar(qRaw, limit));
    if (src === "all" || src === "scielo") push(fetchScielo(qRaw, limit));
    if (src === "all" || src === "serpapi_scholar") push(fetchSerpapiScholar(qRaw, limit));
    if (src === "all" || src === "openai_web") push(fetchSerpapiWeb(qRaw, limit));
    if (src === "all" || src === "perplexity") push(fetchPerplexity(qRaw, limit));
    if (src === "all" || src === "lexml") push(fetchLexml(searchParams, qRaw, limit));

    const results = tasks.length ? await Promise.all(tasks) : [];
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];

    return NextResponse.json(
      {
        ok: true,
        query: qRaw,
        source: src,
        count: items.length,
        errors,
        items: cleanClone(items),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `fatal_${e?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
