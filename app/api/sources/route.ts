// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// --------- Tipos ---------
type Item = {
  source:
    | "openalex"
    | "scielo"
    | "openai_web"
    | "serpapi_scholar"
    | "semanticscholar"
    | "perplexity"
    | "lexml";
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

type FetchResult = { items: Item[]; error?: string };

// --------- Helpers ---------
const email =
  process.env.CONTACT_MAIL ||
  process.env.CONTACT_EMAIL ||
  "contato@example.com";

const serpApiKey = process.env.SERPAPI_API_KEY || "";
const s2Key = process.env.S2_API_KEY || "";
const pplxKey = process.env.PPLX_API_KEY || "";

function ua() {
  // SciELO e outros rejeitam requisições sem UA decente.
  return `Mozilla/5.0 (compatible; ResearchBot/1.0; +mailto:${email})`;
}

function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function n(x: any) {
  const v = Number(x);
  return Number.isFinite(v) ? v : undefined;
}

// ============ OPENALEX ============
async function fetchOpenAlex(q: string, limit: number): Promise<FetchResult> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${encodeURIComponent(email)}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": ua() },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `openalex_${r.status}` };

    const j = await r.json();
    const items: Item[] = (j?.results ?? []).slice(0, limit).map((w: any) => ({
      source: "openalex",
      title: w?.title ?? "",
      url: w?.id ?? w?.host_venue?.url ?? "",
      year: n(w?.publication_year),
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

// ============ SCIELO ============
async function fetchScielo(q: string, limit: number): Promise<FetchResult> {
  // 1) Busca pública JSON
  const url1 = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  try {
    let r = await fetch(url1, {
      headers: {
        Accept: "application/json",
        "User-Agent": ua(),
        Referer: "https://search.scielo.org/",
      },
      cache: "no-store",
    });

    // Alguns PoPs respondem 403 sem UA; tentamos novamente com outro header
    if (r.status === 403) {
      r = await fetch(url1, {
        headers: {
          Accept: "application/json",
          "User-Agent": ua(),
          "X-Requested-With": "XMLHttpRequest",
        },
        cache: "no-store",
      });
    }

    if (!r.ok) return { items: [], error: `scielo_${r.status}` };

    const j: any = await r.json();
    const docs = j?.documents ?? j?.results ?? [];
    const items: Item[] = docs.slice(0, limit).map((d: any) => ({
      source: "scielo",
      title: d?.title ?? d?.document?.title ?? "",
      url: d?.link ?? d?.url ?? "",
      year: n(d?.year),
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

// ============ SERPAPI – WEB ============
async function fetchSerpWeb(q: string, limit: number): Promise<FetchResult> {
  if (!serpApiKey) return { items: [], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    q
  )}&hl=pt-BR&num=${limit}&api_key=${encodeURIComponent(serpApiKey)}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": ua() }, cache: "no-store" });
    if (!r.ok) return { items: [], error: `serpapi_${r.status}` };

    const j: any = await r.json();
    const results = j?.organic_results ?? [];
    const items: Item[] = results.slice(0, limit).map((o: any) => ({
      source: "openai_web",
      title: o?.title || o?.link || "",
      url: o?.link,
      snippet: o?.snippet,
    }));
    return { items };
  } catch (e: any) {
    return { items: [], error: `serpapi_err_${e?.message || "x"}` };
  }
}

// ============ SERPAPI – GOOGLE SCHOLAR ============
async function fetchSerpScholar(q: string, limit: number): Promise<FetchResult> {
  if (!serpApiKey) return { items: [], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
    q
  )}&hl=pt-BR&num=${limit}&api_key=${encodeURIComponent(serpApiKey)}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": ua() }, cache: "no-store" });
    if (!r.ok) return { items: [], error: `scholar_${r.status}` };

    const j: any = await r.json();
    const results = j?.organic_results ?? j?.scholar_results ?? [];
    const items: Item[] = results.slice(0, limit).map((o: any) => ({
      source: "serpapi_scholar",
      title: o?.title || "",
      url: o?.link || o?.result_id || "",
      year: n(o?.publication_info?.year),
      authors:
        (o?.publication_info?.authors ?? [])
          .map((a: any) => a?.name)
          .filter(Boolean) || [],
      snippet: o?.snippet,
    }));
    return { items };
  } catch (e: any) {
    return { items: [], error: `scholar_err_${e?.message || "x"}` };
  }
}

// ============ SEMANTIC SCHOLAR (S2) ============
async function fetchSemanticScholar(q: string, limit: number): Promise<FetchResult> {
  // Documentação: GET /graph/v1/paper/search?query=&limit=&fields=
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    q
  )}&limit=${limit}&fields=title,year,authors,url,abstract,citationCount`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": ua(),
  };
  if (s2Key) headers["x-api-key"] = s2Key;

  try {
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) {
      const code = r.status;
      // 401/403 geralmente indicam falta de S2_API_KEY válida
      return { items: [], error: `semanticscholar_${code}` };
    }
    const j: any = await r.json();
    const data = j?.data ?? j?.papers ?? [];
    const items: Item[] = data.slice(0, limit).map((p: any) => ({
      source: "semanticscholar",
      title: p?.title || "",
      url: p?.url,
      year: n(p?.year),
      authors:
        (p?.authors ?? []).map((a: any) => a?.name).filter(Boolean) || [],
      snippet: p?.abstract,
      extra: { citationCount: p?.citationCount },
    }));
    return { items };
  } catch (e: any) {
    return { items: [], error: `semanticscholar_err_${e?.message || "x"}` };
  }
}

// ============ PERPLEXITY ============
async function fetchPerplexity(q: string, limit: number): Promise<FetchResult> {
  if (!pplxKey) return { items: [], error: "perplexity_missing_key" };

  // Modelos “online” retornam citations; usamos o campo 'citations' se vier.
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar-small-online", // compatível com citations
    return_citations: true,
    messages: [{ role: "user", content: `Liste ${limit} fontes úteis sobre: ${q}` }],
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pplxKey}`,
        "Content-Type": "application/json",
        "User-Agent": ua(),
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { items: [], error: `perplexity_${r.status}` };

    const j: any = await r.json();
    const citations: string[] =
      j?.choices?.[0]?.message?.citations ??
      j?.citations ??
      [];

    const items: Item[] = citations.slice(0, limit).map((u: string) => ({
      source: "perplexity",
      title: u,
      url: u,
    }));
    return { items };
  } catch (e: any) {
    return { items: [], error: `perplexity_err_${e?.message || "x"}` };
  }
}

// ============ LEXML (SRU + CQL) ============
// Constrói a query CQL aceitando múltiplos filtros.
function buildLexmlCQL(params: URLSearchParams): { cql: string; ok: boolean; why?: string } {
  const term = (params.get("term") || params.get("q") || "").trim();
  const tipo = (params.get("tipo_documento") || "").trim(); // ex.: "Legislação"
  const numero = (params.get("numero") || "").trim();
  const ano = (params.get("ano") || "").trim(); // "2010-2015" ou "2020"
  const localidade = (params.get("localidade") || "").trim();
  const autoridade = (params.get("autoridade") || "").trim();
  const excluir = (params.get("excluir") || "").trim();

  const parts: string[] = [];

  if (term) {
    parts.push(`(dc.title all "${term}" or dc.description all "${term}")`);
  } else {
    return { cql: "", ok: false, why: "missing_term" };
  }

  if (tipo) {
    // aceita múltiplos separados por vírgula
    const tipos = tipo.split(",").map((t) => t.trim()).filter(Boolean);
    if (tipos.length) {
      const clause = tipos
        .map((t) =>
          t.includes(" ")
            ? `facet-tipoDocumento all "${t}"`
            : `facet-tipoDocumento any "${t}"`
        )
        .join(" or ");
      parts.push(`(${clause})`);
    }
  }

  if (numero) {
    parts.push(`(urn any "${numero}" or dc.title any "${numero}")`);
  }

  if (ano) {
    if (ano.includes("-")) {
      const [a, b] = ano.replace(/\s/g, "").split("-");
      const ai = parseInt(a || "");
      const bi = parseInt(b || "");
      if (Number.isFinite(ai) && Number.isFinite(bi)) {
        parts.push(`(date >= "${ai}" and date <= "${bi}")`);
      }
    } else {
      parts.push(`date any "${ano}"`);
    }
  }

  if (localidade) {
    parts.push(
      localidade.includes(" ")
        ? `localidade = "${localidade}"`
        : `localidade any "${localidade}"`
    );
  }

  if (autoridade) {
    parts.push(
      autoridade.includes(" ")
        ? `autoridade = "${autoridade}"`
        : `autoridade any "${autoridade}"`
    );
  }

  if (excluir) {
    const palavras = excluir
      .split(/[,\s]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (palavras.length) {
      const nots = palavras
        .map((p) =>
          p.includes(" ")
            ? `(dc.title all "${p}" or dc.description all "${p}")`
            : `(dc.title any "${p}" or dc.description any "${p}")`
        )
        .join(" or ");
      parts.push(`not (${nots})`);
    }
  }

  return { cql: parts.join(" and "), ok: true };
}

function parseLexmlDC(xml: string, limit: number): Item[] {
  // Parse simples por regex (suficiente pro DC de SRU):
  const recRe = /<record\b[\s\S]*?<\/record>/gi;
  const get = (s: string, re: RegExp) => s.match(re)?.[1]?.trim();

  const items: Item[] = [];
  let m: RegExpExecArray | null;
  while ((m = recRe.exec(xml)) && items.length < limit) {
    const chunk = m[0];

    const title =
      get(chunk, /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || "Sem título";
    const urn = get(chunk, /<urn[^>]*>([\s\S]*?)<\/urn>/i) || "";
    const url = urn ? `https://www.lexml.gov.br/urn/${urn}` : undefined;
    const year = n(get(chunk, /<dc:date[^>]*>(\d{4})/i));
    const desc = get(chunk, /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);

    items.push({
      source: "lexml",
      title,
      url,
      year,
      snippet: desc,
      extra: { urn },
    });
  }
  return items;
}

async function fetchLexml(params: URLSearchParams, limit: number): Promise<FetchResult> {
  const { cql, ok, why } = buildLexmlCQL(params);
  if (!ok) return { items: [], error: why || "lexml_missing_term" };

  const url = `https://www.lexml.gov.br/busca/SRU?operation=searchRetrieve&version=1.1&query=${encodeURIComponent(
    cql
  )}&maximumRecords=${limit}&startRecord=1&recordSchema=dc`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/xml", "User-Agent": ua() },
      cache: "no-store",
    });
    if (!r.ok) return { items: [], error: `lexml_${r.status}` };

    const xml = await r.text();
    const items = parseLexmlDC(xml, limit);
    return { items };
  } catch (e: any) {
    return { items: [], error: `lexml_err_${e?.message || "x"}` };
  }
}

// ============ HANDLER ============
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const sp = url.searchParams;

    // Para fontes "normais", usamos q. Para LexML, aceitamos q OU term.
    const src = (sp.get("source") || "all").toLowerCase();
    const qRaw = sp.get("q") || "";
    const limit = Math.max(1, Math.min(10, Number(sp.get("limit")) || 5));

    const errors: string[] = [];
    const jobs: Promise<FetchResult>[] = [];

    const want = (name: string) => src === "all" || src === name;

    // Exigir termo quando não for LexML
    if (!qRaw && src !== "lexml") {
      return NextResponse.json(
        { ok: false, error: "missing_query", items: [] },
        { status: 400 }
      );
    }

    if (want("openalex")) jobs.push(fetchOpenAlex(qRaw, limit));
    if (want("scielo")) jobs.push(fetchScielo(qRaw, limit));
    if (want("openai_web")) jobs.push(fetchSerpWeb(qRaw, limit));
    if (want("serpapi_scholar")) jobs.push(fetchSerpScholar(qRaw, limit));
    if (want("semanticscholar")) jobs.push(fetchSemanticScholar(qRaw, limit));
    if (want("perplexity")) jobs.push(fetchPerplexity(qRaw, limit));
    if (want("lexml")) jobs.push(fetchLexml(sp, limit)); // usa term/q + filtros

    const all = await Promise.all(jobs);
    const items = all.flatMap((r) => r.items);
    all.forEach((r) => r.error && errors.push(r.error));

    return NextResponse.json(
      {
        ok: true,
        query: sp.get("term") || qRaw, // mostra term quando for lexml
        source: src,
        count: items.length,
        errors,
        items: jsonClone(items),
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
