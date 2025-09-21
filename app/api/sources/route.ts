// app/api/sources/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// usar Node (não Edge) para evitar restrições de rede e facilitar parse
export const runtime = "nodejs";

type Item = {
  source:
    | "openalex"
    | "scielo"
    | "semanticscholar"
    | "serpapi_scholar"
    | "openai_web"
    | "perplexity"
    | "lexml";
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

function email() {
  return (
    process.env.CONTACT_MAIL ||
    process.env.CONTACT_EMAIL ||
    "contato@example.com"
  );
}

function cleanClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function getInt(v: string | null, def: number, min = 1, max = 10) {
  const n = Number(v ?? "") || def;
  return Math.max(min, Math.min(max, n));
}

const F_TIMEOUT = 15000;

/* ------------------------ OpenAlex ------------------------ */
async function fetchOpenAlex(q: string, limit: number) {
  const mail = encodeURIComponent(email());
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${mail}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `openalex_${r.status}` };

    const j: any = await r.json();
    const items: Item[] = (j?.results ?? []).map((w: any) => ({
      source: "openalex",
      title: w?.title ?? w?.display_name ?? "",
      url:
        w?.primary_location?.landing_page_url ||
        w?.id ||
        w?.host_venue?.url ||
        undefined,
      year: Number(w?.publication_year) || undefined,
      authors:
        (w?.authorships ?? [])
          .map((a: any) => a?.author?.display_name)
          .filter(Boolean) || [],
      snippet: w?.abstract_inverted_index
        ? Object.keys(w.abstract_inverted_index).slice(0, 30).join(" ")
        : undefined,
      extra: { cited_by_count: w?.cited_by_count, openalex_id: w?.id },
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `openalex_err_${e?.message || "x"}` };
  }
}

/* ------------------------ SciELO (search API) ------------------------
 * Endpoint público de busca com retorno JSON (sem chave).
 * Observação: este endpoint é o que retorna resultados textuais por termo.
 * ------------------------------------------------------------------- */
async function fetchScielo(q: string, limit: number) {
  const url = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `scielo_${r.status}` };

    const j: any = await r.json();
    const docs: any[] = j?.documents ?? j?.results ?? [];
    const items: Item[] = docs.slice(0, limit).map((d: any) => ({
      source: "scielo",
      title: d?.title ?? d?.document?.title ?? "",
      url: d?.link ?? d?.url ?? undefined,
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

/* ------------------------ Semantic Scholar ------------------------
 * Graph API v1 /paper/search (com x-api-key = S2_API_KEY).
 * ----------------------------------------------------------------- */
async function fetchSemanticScholar(q: string, limit: number) {
  const fields =
    "title,authors,year,abstract,externalIds,doi,url,citationCount,openAccessPdf";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    q
  )}&limit=${limit}&fields=${encodeURIComponent(fields)}`;

  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "x-api-key": process.env.S2_API_KEY || "",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `s2_${r.status}` };

    const j: any = await r.json();
    const items: Item[] = (j?.data ?? []).map((p: any) => ({
      source: "semanticscholar",
      title: p?.title ?? "",
      url:
        p?.openAccessPdf?.url ||
        (p?.doi ? `https://doi.org/${p.doi}` : p?.url) ||
        undefined,
      year: Number(p?.year) || undefined,
      authors:
        (p?.authors ?? []).map((a: any) => a?.name).filter(Boolean) || [],
      snippet: p?.abstract,
      extra: {
        citationCount: p?.citationCount,
        doi: p?.doi || p?.externalIds?.DOI,
      },
    }));
    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `s2_err_${e?.message || "x"}` };
  }
}

/* ------------------------ SerpAPI - Google Scholar ------------------------ */
async function fetchSerpapiScholar(q: string, limit: number) {
  const key = process.env.SERPAPI_API_KEY || "";
  if (!key) return { items: [] as Item[], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
    q
  )}&num=${limit}&api_key=${encodeURIComponent(key)}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `serpapi_${r.status}` };

    const j: any = await r.json();
    const rows: any[] = j?.organic_results ?? [];
    const items: Item[] = rows.slice(0, limit).map((it: any) => ({
      source: "serpapi_scholar",
      title: it?.title ?? "",
      url: it?.link ?? it?.resources?.[0]?.link ?? undefined,
      year: it?.publication_info?.year
        ? Number(it.publication_info.year)
        : undefined,
      authors: it?.publication_info?.authors
        ? it.publication_info.authors.map((a: any) => a?.name).filter(Boolean)
        : undefined,
      snippet: it?.snippet,
      extra: { result_id: it?.result_id },
    }));
    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `serpapi_err_${e?.message || "x"}` };
  }
}

/* ------------------------ "OpenAI Web Search" (rótulo) ------------------------
 * Não existe API de busca web da OpenAI. Aqui usamos SerpAPI (engine=google)
 * para trazer resultados gerais da web sob o rótulo openai_web, que depois
 * podem ser resumidos por modelos OpenAI em outra rota.
 * --------------------------------------------------------------------------- */
async function fetchOpenAIWeb(q: string, limit: number) {
  const key = process.env.SERPAPI_API_KEY || "";
  if (!key) return { items: [] as Item[], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    q
  )}&num=${limit}&api_key=${encodeURIComponent(key)}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `openaiweb_${r.status}` };

    const j: any = await r.json();
    const rows: any[] = j?.organic_results ?? [];
    const items: Item[] = rows.slice(0, limit).map((it: any) => ({
      source: "openai_web",
      title: it?.title ?? "",
      url: it?.link ?? undefined,
      snippet: it?.snippet ?? it?.rich_snippet,
      extra: { position: it?.position, displayed_link: it?.displayed_link },
    }));
    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `openaiweb_err_${e?.message || "x"}` };
  }
}

/* ------------------------ Perplexity Sonar ------------------------
 * Chat Completions com busca online; retorna answer + search_results/citations.
 * Modelos comuns: "sonar", "sonar-pro", "sonar-reasoning" (ajuste segundo sua conta).
 * ----------------------------------------------------------------- */
async function fetchPerplexity(q: string, limit: number) {
  const key =
    process.env.PPLX_API_KEY ||
    process.env.PERPLEXITY_API_KEY ||
    process.env.PPLX_API_TOKEN ||
    "";
  if (!key) return { items: [] as Item[], error: "perplexity_missing_key" };

  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar-pro", // ajuste conforme seu plano ("sonar" / "sonar-reasoning")
    messages: [{ role: "user", content: q }],
    // algumas contas aceitam estes campos; se não, pode remover:
    search_recency_filter: "month",
    top_k: limit,
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `perplexity_${r.status}` };

    const j: any = await r.json();
    const msg = j?.choices?.[0]?.message;
    const answer: string | undefined = msg?.content;
    // alguns modelos retornam "citations" ou "search_results" em message
    const cites: any[] =
      msg?.citations || msg?.search_results || j?.citations || [];

    const items: Item[] = (cites || []).slice(0, limit).map((c: any) => ({
      source: "perplexity",
      title: c?.title || c?.url || "",
      url: c?.url,
      snippet: c?.snippet,
    }));

    // anexar a resposta da Perplexity no campo extra do primeiro item (opcional)
    if (answer) {
      items.unshift({
        source: "perplexity",
        title: "[Resposta Perplexity]",
        snippet: answer,
        extra: { type: "answer" },
      });
    }

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `perplexity_err_${e?.message || "x"}` };
  }
}

/* ------------------------ LexML (SRU/DC) ------------------------
 * Monta consulta CQL para LexML SRU usando campos:
 * - term (termo no título/ementa)
 * - tipo_documento (ex.: "Legislação", "Jurisprudência", "Doutrina", "Proposição Legislativa")
 * - numero, ano (ou intervalo "2010-2015"), localidade, autoridade, excluir
 * Observação: índices SRU podem variar. Mantemos DC estáveis (dc.title / dc.description / date / urn)
 * e tentamos "facet-tipoDocumento" quando fornecido (em muitos casos funciona).
 * ---------------------------------------------------------------- */
function buildLexmlCQL(params: {
  term?: string | null;
  tipo_documento?: string | null;
  numero?: string | null;
  ano?: string | null;
  localidade?: string | null;
  autoridade?: string | null;
  excluir?: string | null;
}) {
  const qp: string[] = [];

  const term = (params.term || "").trim();
  if (term) {
    qp.push(`(dc.title all "${term}" or dc.description all "${term}")`);
  }

  const tipo = (params.tipo_documento || "").trim();
  if (tipo) {
    // tentativa de facet; caso não funcione no seu caso, remover esta linha
    qp.push(
      tipo.includes(" ")
        ? `(facet-tipoDocumento all "${tipo}")`
        : `(facet-tipoDocumento any "${tipo}")`
    );
  }

  const numero = (params.numero || "").trim();
  if (numero) {
    qp.push(`(urn any "${numero}" or dc.title any "${numero}")`);
  }

  const ano = (params.ano || "").trim();
  if (ano) {
    if (ano.includes("-")) {
      const [a, b] = ano.replace(/\s+/g, "").split("-");
      const ai = Number(a) || 0;
      const bi = Number(b) || 0;
      if (ai && bi) qp.push(`(date >= "${ai}" and date <= "${bi}")`);
    } else {
      qp.push(`date any "${ano}"`);
    }
  }

  const local = (params.localidade || "").trim();
  if (local) {
    qp.push(local.includes(" ") ? `localidade = "${local}"` : `localidade any "${local}"`);
  }

  const aut = (params.autoridade || "").trim();
  if (aut) {
    qp.push(aut.includes(" ") ? `autoridade = "${aut}"` : `autoridade any "${aut}"`);
  }

  const excluir = (params.excluir || "").trim();
  if (excluir) {
    const termos =
      excluir.indexOf(",") >= 0
        ? excluir.split(",").map((w) => w.trim()).filter(Boolean)
        : excluir.split(/\s+/).map((w) => w.trim()).filter(Boolean);
    if (termos.length) {
      const exClauses = termos.map((w) =>
        w.includes(" ")
          ? `(dc.title all "${w}" or dc.description all "${w}")`
          : `(dc.title any "${w}" or dc.description any "${w}")`
      );
      qp.push(`not (${exClauses.join(" or ")})`);
    }
  }

  return qp.length ? qp.join(" and ") : "";
}

function parseLexmlDC(xml: string, limit: number): Item[] {
  const out: Item[] = [];
  // parse leve; evita DOM para reduzir dependências
  const recRe = /<record\b[\s\S]*?<\/record>/gi;
  let m: RegExpExecArray | null;
  while ((m = recRe.exec(xml)) && out.length < limit) {
    const chunk = m[0];
    // títulos dc:title
    const tMatch = chunk.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
    const title = tMatch ? tMatch[1].replace(/\s+/g, " ").trim() : "Título não disponível";

    // URN para linkar no portal
    const urnMatch = chunk.match(/<urn[^>]*>([\s\S]*?)<\/urn>/i);
    const urn = urnMatch ? urnMatch[1].trim() : "";

    // ano a partir de dc:date (quando presente)
    const dateMatch = chunk.match(/<dc:date[^>]*>(\d{4})/i);
    const year = dateMatch ? Number(dateMatch[1]) : undefined;

    // descrição
    const descMatch = chunk.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
    const desc = descMatch ? descMatch[1].replace(/\s+/g, " ").trim() : undefined;

    const url = urn ? `https://www.lexml.gov.br/urn/${urn}` : undefined;

    out.push({
      source: "lexml",
      title,
      url,
      year,
      snippet: desc,
      extra: { urn },
    });
  }
  return out;
}

async function fetchLexml(params: {
  term?: string | null;
  tipo_documento?: string | null;
  numero?: string | null;
  ano?: string | null;
  localidade?: string | null;
  autoridade?: string | null;
  excluir?: string | null;
}, limit: number) {
  const query = buildLexmlCQL(params);
  if (!query) return { items: [] as Item[], error: "lexml_missing_query" };

  const base = "https://www.lexml.gov.br/busca/SRU";
  const url = `${base}?operation=searchRetrieve&version=1.1&recordSchema=dc&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(
    query
  )}`;
  try {
    const r = await fetch(url, {
      headers: { Accept: "application/xml" },
      cache: "no-store",
      signal: AbortSignal.timeout(F_TIMEOUT),
    });
    if (!r.ok) return { items: [] as Item[], error: `lexml_${r.status}` };

    const xml = await r.text();
    const items = parseLexmlDC(xml, limit);
    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `lexml_err_${e?.message || "x"}` };
  }
}

/* ------------------------ Handler ------------------------ */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const src = (searchParams.get("source") || "all").toLowerCase();
    const limit = getInt(searchParams.get("limit"), 5);

    // filtros LexML opcionais
    const term = searchParams.get("term") || q;
    const tipo_documento = searchParams.get("tipo_documento");
    const numero = searchParams.get("numero");
    const ano = searchParams.get("ano");
    const localidade = searchParams.get("localidade");
    const autoridade = searchParams.get("autoridade");
    const excluir = searchParams.get("excluir");

    if (!q && !term)
      return NextResponse.json(
        { ok: false, error: "missing_query", items: [] },
        { status: 400 }
      );

    const tasks: Promise<{ items: Item[]; error?: string }>[] = [];

    if (src === "all" || src === "openalex") tasks.push(fetchOpenAlex(q, limit));
    if (src === "all" || src === "scielo") tasks.push(fetchScielo(q, limit));
    if (src === "all" || src === "semanticscholar")
      tasks.push(fetchSemanticScholar(q, limit));
    if (src === "all" || src === "serpapi_scholar")
      tasks.push(fetchSerpapiScholar(q, limit));
    if (src === "all" || src === "openai_web")
      tasks.push(fetchOpenAIWeb(q, limit));
    if (src === "all" || src === "perplexity")
      tasks.push(fetchPerplexity(q, limit));
    if (src === "all" || src === "lexml")
      tasks.push(
        fetchLexml(
          { term, tipo_documento, numero, ano, localidade, autoridade, excluir },
          limit
        )
      );

    const results = await Promise.all(tasks);
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];

    return NextResponse.json(
      {
        ok: true,
        query: q || term,
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
