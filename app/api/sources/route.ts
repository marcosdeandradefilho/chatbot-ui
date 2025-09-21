// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// forçamos Node.js (nada de Edge por causa de fetches externos e parsers)
export const runtime = "nodejs";

// -----------------------------
// Tipos e utilitários
// -----------------------------
type Item = {
  source:
    | "openalex"
    | "semanticscholar"
    | "serpapi_scholar"
    | "openai_web"
    | "perplexity"
    | "scielo"
    | "lexml";
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
  // garante que só dados serializáveis vão pro JSON
  return JSON.parse(JSON.stringify(v));
}

function ua() {
  // user-agent simples pra endpoints que bloqueiam requests “anônimos”
  const mail = email();
  return `Mozilla/5.0 (compatible; chatbot-ui/1.0; +${mail || "contact@example.com"})`;
}

// -----------------------------
// OpenAlex
// -----------------------------
async function fetchOpenAlex(q: string, limit: number) {
  const mail = encodeURIComponent(email() || "contato@example.com");
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${mail}`;

  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": ua(),
      },
      cache: "no-store",
    });
    if (!r.ok) return { items: [] as Item[], error: `openalex_${r.status}` };

    const j: any = await r.json();
    const items: Item[] = (j?.results ?? []).map((w: any) => ({
      source: "openalex",
      title: w?.title ?? "",
      url:
        w?.primary_location?.landing_page_url ||
        w?.id ||
        w?.host_venue?.url ||
        "",
      year: Number(w?.publication_year) || undefined,
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
    return { items: [] as Item[], error: `openalex_err_${e?.message || "x"}` };
  }
}

// -----------------------------
// Semantic Scholar (S2) – usa S2_API_KEY se existir
// -----------------------------
async function fetchSemanticScholar(q: string, limit: number) {
  const fields =
    "title,year,authors,name,abstract,url,externalIds,citationCount";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    q
  )}&limit=${limit}&fields=${encodeURIComponent(fields)}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": ua(),
  };
  if (process.env.S2_API_KEY) headers["x-api-key"] = process.env.S2_API_KEY!;

  try {
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok)
      return { items: [] as Item[], error: `semanticscholar_${r.status}` };

    const j: any = await r.json();
    const items: Item[] = (j?.data ?? []).map((p: any) => {
      const doi =
        p?.externalIds?.DOI || p?.externalIds?.doi || p?.externalIds?.Doi;
      const url = p?.url || (doi ? `https://doi.org/${doi}` : "");
      return {
        source: "semanticscholar",
        title: p?.title || "",
        url,
        year: Number(p?.year) || undefined,
        authors:
        (p?.authors ?? [])
            .map((a: any) => a?.name)
            .filter(Boolean),
        snippet: p?.abstract || undefined,
        extra: { citationCount: p?.citationCount },
      } as Item;
    });

    return { items };
  } catch (e: any) {
    return {
      items: [] as Item[],
      error: `semanticscholar_err_${e?.message || "x"}`,
    };
  }
}

// -----------------------------
// SerpAPI – Google Scholar
// -----------------------------
async function fetchSerpapiScholar(q: string, limit: number) {
  if (!process.env.SERPAPI_API_KEY)
    return { items: [] as Item[], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google_scholar&q=${encodeURIComponent(
    q
  )}&num=${limit}&api_key=${encodeURIComponent(process.env.SERPAPI_API_KEY!)}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": ua() }, cache: "no-store" });
    if (!r.ok) return { items: [] as Item[], error: `serpapi_${r.status}` };
    const j: any = await r.json();

    const items: Item[] = (j?.organic_results ?? []).slice(0, limit).map((it: any) => ({
      source: "serpapi_scholar",
      title: it?.title || "",
      url: it?.link || it?.result_id || "",
      year: (() => {
        // tenta extrair ano de publication_info.summary (ex.: "... - 2019 - ...")
        const s = it?.publication_info?.summary || "";
        const m = s.match(/\b(19|20)\d{2}\b/);
        return m ? Number(m[0]) : undefined;
      })(),
      authors:
        (it?.publication_info?.authors ?? [])
          .map((a: any) => a?.name)
          .filter(Boolean) || [],
      snippet: it?.snippet || undefined,
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `serpapi_err_${e?.message || "x"}` };
  }
}

// -----------------------------
// OpenAI Web (fallback via Google – SerpAPI)
// -----------------------------
async function fetchOpenAIWeb(q: string, limit: number) {
  // Implementação segura e que “funciona já”: usamos Google Web via SerpAPI como fallback para “openai_web”.
  if (!process.env.SERPAPI_API_KEY)
    return { items: [] as Item[], error: "serpapi_missing_key" };

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    q
  )}&num=${limit}&api_key=${encodeURIComponent(process.env.SERPAPI_API_KEY!)}`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": ua() }, cache: "no-store" });
    if (!r.ok) return { items: [] as Item[], error: `openai_web_${r.status}` };
    const j: any = await r.json();

    const items: Item[] = (j?.organic_results ?? []).slice(0, limit).map((it: any) => ({
      source: "openai_web",
      title: it?.title || "",
      url: it?.link || "",
      snippet: it?.snippet || undefined,
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `openai_web_err_${e?.message || "x"}` };
  }
}

// -----------------------------
// Perplexity (citations)
// -----------------------------
async function fetchPerplexity(q: string, limit: number) {
  if (!process.env.PERPLEXITY_API_KEY)
    return { items: [] as Item[], error: "perplexity_missing_key" };

  // Modelos “sonar-*-online” retornam citações (links). Vamos extrair as URLs e montar itens.
  const url = "https://api.perplexity.ai/chat/completions";
  const body = {
    model: "sonar-small-online", // bom custo/benefício; pode trocar por "sonar-medium-online"
    messages: [{ role: "user", content: q }],
    return_citations: true,
    // para manter barato/rápido, não precisamos de streaming aqui
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": ua(),
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) return { items: [] as Item[], error: `perplexity_${r.status}` };

    const j: any = await r.json();

    // As citações costumam vir em choices[0].message.citations (array de URLs)
    const citations: string[] =
      j?.choices?.[0]?.message?.citations ||
      j?.citations ||
      j?.metadata?.citations ||
      [];

    const items: Item[] = citations.slice(0, limit).map((link: string, idx: number) => ({
      source: "perplexity",
      title: `Fonte #${idx + 1}`,
      url: link,
      snippet: undefined,
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `perplexity_err_${e?.message || "x"}` };
  }
}

// -----------------------------
// SciELO (API pública) com fallback OpenAlex
// -----------------------------
async function fetchScielo(q: string, limit: number) {
  const api = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  try {
    const r = await fetch(api, {
      headers: {
        Accept: "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9",
        Referer: "https://search.scielo.org/",
        "User-Agent": ua(),
        "Cache-Control": "no-store",
      },
    });

    if (r.status === 403) {
      // fallback para OpenAlex “forçando” resultados próximos a SciELO
      const oaUrl = `https://api.openalex.org/works?search=${encodeURIComponent(
        q + " scielo"
      )}&per-page=${limit}`;
      const oa = await fetch(oaUrl, {
        headers: { Accept: "application/json", "User-Agent": ua() },
        cache: "no-store",
      });
      if (!oa.ok) return { items: [] as Item[], error: "scielo_403" };
      const j: any = await oa.json();
      const items: Item[] = (j?.results ?? []).slice(0, limit).map((w: any) => ({
        source: "scielo",
        title: w?.title ?? "",
        url:
          w?.primary_location?.landing_page_url ||
          w?.id ||
          w?.host_venue?.url ||
          "",
        year: Number(w?.publication_year) || undefined,
        authors:
          (w?.authorships ?? [])
            .map((a: any) => a?.author?.display_name)
            .filter(Boolean) || [],
        snippet: w?.abstract_inverted_index
          ? Object.keys(w.abstract_inverted_index).slice(0, 40).join(" ")
          : undefined,
        extra: { via: "openalex_fallback" },
      }));
      return { items, error: "scielo_403" };
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

// -----------------------------
// LexML SRU – consulta com filtros avançados (recordSchema=dc)
// -----------------------------
function buildLexmlCQL(params: {
  term?: string | null;
  tipo_documento?: string | null;
  numero?: string | null;
  ano?: string | null; // “2020” ou “2010-2015”
  localidade?: string | null;
  autoridade?: string | null;
  excluir?: string | null; // palavras separadas por vírgula ou espaço
}) {
  const {
    term,
    tipo_documento,
    numero,
    ano,
    localidade,
    autoridade,
    excluir,
  } = params;

  const queryParts: string[] = [];

  // termo em título/descrição
  if (term) {
    const t = term.trim();
    if (t) queryParts.push(`(dc.title all "${t}" or dc.description all "${t}")`);
  }

  // tipo de documento: pode vir com acentos; usamos “any/all”
  if (tipo_documento) {
    const raw = tipo_documento
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (raw.length) {
      const clauses = raw.map((t) =>
        t.includes(" ")
          ? `facet-tipoDocumento all "${t}"`
          : `facet-tipoDocumento any "${t}"`
      );
      queryParts.push(`(${clauses.join(" or ")})`);
    }
  }

  // número
  if (numero && numero.trim()) {
    const num = numero.trim();
    queryParts.push(`(urn any "${num}" or dc.title any "${num}")`);
  }

  // ano simples ou intervalo
  if (ano && ano.trim()) {
    const s = ano.trim();
    if (s.includes("-")) {
      const parts = s.replace(/\s+/g, "").split("-");
      const y1 = Number(parts[0]);
      const y2 = Number(parts[1]);
      if (y1 && y2) queryParts.push(`(date >= "${y1}" and date <= "${y2}")`);
    } else {
      queryParts.push(`date any "${s}"`);
    }
  }

  // localidade
  if (localidade && localidade.trim()) {
    const loc = localidade.trim();
    queryParts.push(
      loc.includes(" ") ? `localidade = "${loc}"` : `localidade any "${loc}"`
    );
  }

  // autoridade
  if (autoridade && autoridade.trim()) {
    const auth = autoridade.trim();
    queryParts.push(
      auth.includes(" ")
        ? `autoridade = "${auth}"`
        : `autoridade any "${auth}"`
    );
  }

  // excluir palavras
  if (excluir && excluir.trim()) {
    const arr =
      excluir.indexOf(",") >= 0
        ? excluir.split(",").map((s) => s.trim())
        : excluir.split(/\s+/).map((s) => s.trim());
    const exClauses = arr
      .filter(Boolean)
      .map((w) =>
        w.includes(" ")
          ? `dc.title all "${w}" or dc.description all "${w}"`
          : `dc.title any "${w}" or dc.description any "${w}"`
      );
    if (exClauses.length) queryParts.push(`not (${exClauses.join(" or ")})`);
  }

  return queryParts.join(" and ");
}

function parseLexmlDC(xml: string, limit: number): Item[] {
  // parse simples por regex (sem dependências)
  const out: Item[] = [];
  const rec = /<srw:record\b[\s\S]*?<\/srw:record>/gi;
  let m: RegExpExecArray | null;
  while ((m = rec.exec(xml)) && out.length < limit) {
    const chunk = m[0];

    const title =
      chunk.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.replace(/\s+/g, " ").trim() ||
      "";

    // tentamos pegar “urn” ou dc:identifier com urn
    const urn =
      chunk.match(/<urn[^>]*>([\s\S]*?)<\/urn>/i)?.[1]?.trim() ||
      chunk.match(/<dc:identifier[^>]*>(urn:[^<]+)<\/dc:identifier>/i)?.[1] ||
      "";

    const desc =
      chunk
        .match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/gi)
        ?.map((x) => x.replace(/<[^>]+>/g, "").trim())
        ?.filter(Boolean) ?? [];
    const resumo = desc.length ? desc[0] : "";

    // ano: alguns registros têm <dc:date> ou “date” noutro namespace; tentamos 4 dígitos
    const yMatch =
      chunk.match(/<dc:date[^>]*>(\d{4})/i)?.[1] ||
      chunk.match(/\b(19|20)\d{2}\b/)?.[0] ||
      undefined;

    const url = urn ? `https://www.lexml.gov.br/urn/${urn}` : undefined;

    if (title) {
      out.push({
        source: "lexml",
        title,
        url,
        year: yMatch ? Number(yMatch) : undefined,
        authors: undefined,
        snippet: resumo || undefined,
      });
    }
  }
  return out;
}

async function fetchLexmlAdvanced(
  params: {
    term?: string | null;
    tipo_documento?: string | null;
    numero?: string | null;
    ano?: string | null;
    localidade?: string | null;
    autoridade?: string | null;
    excluir?: string | null;
  },
  limit: number
) {
  const cql = buildLexmlCQL(params);
  if (!cql) return { items: [] as Item[], error: "lexml_missing_filters" };

  const base = "https://www.lexml.gov.br/busca/SRU";
  const url =
    base +
    `?operation=searchRetrieve&version=1.1&recordSchema=dc&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(
      cql
    )}`;

  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/xml",
        "User-Agent": ua(),
        "Cache-Control": "no-store",
      },
    });
    if (!r.ok) return { items: [] as Item[], error: `lexml_${r.status}` };

    const xml = await r.text();
    const items = parseLexmlDC(xml, limit);
    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `lexml_err_${e?.message || "x"}` };
  }
}

// -----------------------------
// Handler
// -----------------------------
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    // fontes
    const src = (searchParams.get("source") || "all").toLowerCase();

    // consulta principal (para todas as fontes, exceto LexML que aceita “term” e filtros)
    const q = (searchParams.get("q") || "").trim();

    // LexML filtros dedicados
    const lexmlParams = {
      term: (searchParams.get("term") || "").trim() || q || null,
      tipo_documento: searchParams.get("tipo_documento"),
      numero: searchParams.get("numero"),
      ano: searchParams.get("ano"),
      localidade: searchParams.get("localidade"),
      autoridade: searchParams.get("autoridade"),
      excluir: searchParams.get("excluir"),
    };

    // limit
    const limit = Math.max(1, Math.min(10, Number(searchParams.get("limit")) || 5));

    // validação mínima:
    if (
      !q &&
      !(
        src === "lexml" &&
        (lexmlParams.term || lexmlParams.tipo_documento || lexmlParams.numero)
      )
    ) {
      // se LexML, aceitamos “term” no lugar de q; caso contrário, exigimos q
      return NextResponse.json(
        { ok: false, error: "missing_query", items: [] },
        { status: 400 }
      );
    }

    const tasks: Promise<{ items: Item[]; error?: string }>[] = [];

    // seleção das fontes
    const wants = (name: string) => src === "all" || src === name;

    if (wants("openalex")) tasks.push(fetchOpenAlex(q || lexmlParams.term || "", limit));
    if (wants("semanticscholar")) tasks.push(fetchSemanticScholar(q || lexmlParams.term || "", limit));
    if (wants("serpapi_scholar")) tasks.push(fetchSerpapiScholar(q || lexmlParams.term || "", limit));
    if (wants("openai_web")) tasks.push(fetchOpenAIWeb(q || lexmlParams.term || "", limit));
    if (wants("perplexity")) tasks.push(fetchPerplexity(q || lexmlParams.term || "", limit));
    if (wants("scielo")) tasks.push(fetchScielo(q || lexmlParams.term || "", limit));
    if (wants("lexml"))
      tasks.push(fetchLexmlAdvanced(lexmlParams, limit));

    const results = await Promise.all(tasks);
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];

    return NextResponse.json(
      {
        ok: true,
        query: q || lexmlParams.term || "",
        source: src,
        count: items.length,
        errors,
        items: cleanClone(items),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    // Nunca deixa tela branca
    return NextResponse.json(
      { ok: false, error: `fatal_${e?.message || "unknown"}` },
      { status: 500 }
    );
  }
}
