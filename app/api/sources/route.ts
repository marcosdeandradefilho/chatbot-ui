// app/api/sources/route.ts
import { NextRequest, NextResponse } from "next/server";
import { fetchOpenAlex, fetchSciELO, fetchLexML } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "edge";

// ------- Tipos -------
type SourceItem = {
  source: "openalex" | "scielo" | "lexml" | "semanticscholar";
  title: string;
  url?: string;
  doi?: string;
  year?: number;
  authors?: string[];
  abstract?: string;
  extra?: Record<string, any>;
};

type AggregatedResponse = {
  query: string;
  items: SourceItem[];
};

// ------- Mapeadores -------

// OpenAlex
function mapOpenAlex(json: any): SourceItem[] {
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  return results.map((w) => {
    const doi = w?.doi || undefined;
    const year = w?.publication_year || undefined;
    const oa = w?.open_access?.oa_url;
    const src = w?.primary_location?.source?.url;
    const url = oa || src || (doi ? `https://doi.org/${doi}` : undefined);
    const authors =
      Array.isArray(w?.authorships)
        ? w.authorships.map((a: any) => a?.author?.display_name).filter(Boolean)
        : undefined;

    return {
      source: "openalex",
      title: w?.display_name ?? "(sem título)",
      url,
      doi,
      year,
      authors,
      abstract: w?.abstract,
      extra: {
        cited_by_count: w?.cited_by_count,
        openalex_id: w?.id,
      },
    };
  });
}

// SciELO ArticleMeta
function mapSciELO(json: any): SourceItem[] {
  const objects: any[] = Array.isArray(json) ? json : (Array.isArray(json?.objects) ? json.objects : []);
  return objects.map((obj: any) => {
    const title =
      obj?.title || obj?.article_title || obj?.titles?.[0]?.title || "(sem título)";

    const year =
      Number(obj?.publication_year) ||
      Number(obj?.year) ||
      (obj?.publication_date ? Number(String(obj.publication_date).slice(0, 4)) : undefined);

    const doi = obj?.doi || obj?.article_doi;
    const url =
      obj?.url || obj?.html_url || (doi ? `https://doi.org/${doi}` : undefined);

    const authors =
      Array.isArray(obj?.authors)
        ? obj.authors
            .map((a: any) => a?.name || [a?.given_names, a?.surname].filter(Boolean).join(" "))
            .filter(Boolean)
        : undefined;

    const abstract =
      obj?.abstract ||
      (Array.isArray(obj?.abstracts) ? obj.abstracts[0]?.text : undefined);

    return {
      source: "scielo",
      title,
      url,
      doi,
      year: Number.isFinite(year) ? year : undefined,
      authors,
      abstract,
      extra: {
        scielo_pid: obj?.pid || obj?.article_pid,
        collection: obj?.collection,
        journal: obj?.source || obj?.journal?.title,
      },
    };
  });
}

// LexML SRU (XML)
function mapLexML(xml: string): SourceItem[] {
  const records = xml.split(/<\/record>\s*/i).filter((seg) => seg.includes("<record"));
  const items: SourceItem[] = [];

  for (const r of records) {
    const get = (tag: string) => {
      const m = r.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? m[1].trim() : undefined;
    };
    const title = get("dc:title") || get("title") || "(sem título)";
    const id = get("dc:identifier") || get("identifier");
    const dateStr = get("dc:date") || get("date");
    const year = dateStr ? Number(String(dateStr).slice(0, 4)) : undefined;
    const url = id && /^https?:\/\//i.test(id) ? id : undefined;

    items.push({
      source: "lexml",
      title,
      url,
      year: Number.isFinite(year) ? year : undefined,
      extra: { identifier: id, rawDate: dateStr },
    });
  }

  return items;
}

// Semantic Scholar (S2)
async function fetchSemanticScholar(query: string) {
  const fields = "title,authors,year,abstract,doi,url";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
    query
  )}&limit=5&fields=${fields}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.S2_API_KEY) headers["x-api-key"] = process.env.S2_API_KEY!;
  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) throw new Error("Erro no Semantic Scholar");
  return res.json();
}

function mapSemanticScholar(json: any): SourceItem[] {
  const data: any[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((p) => {
    const doi = p?.doi || undefined;
    const url = p?.url || (doi ? `https://doi.org/${doi}` : undefined);
    const authors = Array.isArray(p?.authors)
      ? p.authors.map((a: any) => a?.name).filter(Boolean)
      : undefined;
    return {
      source: "semanticscholar",
      title: p?.title ?? "(sem título)",
      url,
      doi,
      year: p?.year ?? undefined,
      authors,
      abstract: p?.abstract,
    };
  });
}

// ------- Agregador -------
async function runAggregation(query: string): Promise<AggregatedResponse> {
  const items: SourceItem[] = [];

  try { const oa = await fetchOpenAlex(query); items.push(...mapOpenAlex(oa)); } catch {}
  try { const sc = await fetchSciELO(query); items.push(...mapSciELO(sc)); } catch {}
  try { const xml = await fetchLexML(query); items.push(...mapLexML(xml)); } catch {}
  try { const s2 = await fetchSemanticScholar(query); items.push(...mapSemanticScholar(s2)); } catch {}

  const dedup = new Map<string, SourceItem>();
  for (const it of items) {
    const key = (it.doi?.toLowerCase() ?? "") || it.title.toLowerCase();
    if (!dedup.has(key)) dedup.set(key, it);
  }
  return { query, items: Array.from(dedup.values()) };
}

// ------- Handlers -------
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const query = (body?.query ?? "").toString().trim();
    if (!query) {
      return NextResponse.json({ error: "Informe 'query' no corpo da requisição." }, { status: 400 });
    }
    const data = await runAggregation(query);
    return NextResponse.json(data, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Erro interno ao agregar fontes." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "Use ?q=termo para testar." }, { status: 400 });
  try {
    const data = await runAggregation(q);
    return NextResponse.json(data, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Erro interno ao agregar fontes." }, { status: 500 });
  }
}
