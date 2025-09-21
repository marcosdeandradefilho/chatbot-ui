// app/api/sources/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";       // evita limites do Edge Runtime
export const dynamic = "force-dynamic";

type SourceItem = {
  source: "openalex" | "scielo" | "lexml";
  title: string;
  url?: string;
  doi?: string;
  year?: number;
  authors?: string[];
  abstract?: string;
  extra?: Record<string, any>;
};

const CONTACT = process.env.CONTACT_MAIL || "contact@example.com";

/* -------- OpenAlex -------- */
async function fetchOpenAlex(q: string, limit: number): Promise<SourceItem[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": CONTACT }, cache: "no-store" });
  if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.slice(0, limit).map((w: any) => ({
    source: "openalex",
    title: w?.title,
    url:
      w?.primary_location?.landing_page_url ||
      w?.primary_location?.source?.homepage_url ||
      (w?.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi.org\//, "")}` : undefined) ||
      w?.id,
    doi: w?.doi,
    year: w?.publication_year,
    authors: (w?.authorships || []).map((a: any) => a?.author?.display_name).filter(Boolean),
    abstract: w?.abstract_inverted_index ? Object.keys(w.abstract_inverted_index).join(" ") : undefined,
    extra: { openalex_id: w?.id },
  }));
}

/* -------- SciELO (ArticleMeta) -------- */
async function fetchSciELO(q: string, limit: number): Promise<SourceItem[]> {
  const base = "https://articlemeta.scielo.org/api/v1/article/";
  const url = `${base}?q=${encodeURIComponent(`"${q}"`)}&from=0&size=${limit}&format=json`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`SciELO ${res.status}`);
  const rows = await res.json();
  const arr = Array.isArray(rows) ? rows : [];
  return arr.slice(0, limit).map((it: any) => ({
    source: "scielo",
    title: it?.title || it?.titles?.[0]?.text,
    url: it?.doi ? `https://doi.org/${it.doi}` : undefined,
    doi: it?.doi,
    year: it?.year || (it?.publication_date ? Number(String(it.publication_date).slice(0, 4)) : undefined),
    authors: (it?.authors || [])
      .map((a: any) => a?.fullname || [a?.given_names, a?.surname].filter(Boolean).join(" "))
      .filter(Boolean),
    abstract: it?.abstract || it?.abstracts?.[0]?.text,
    extra: { collection: it?.collection, journal: it?.journal?.title },
  }));
}

/* -------- LexML (SRU) -------- */
async function fetchLexML(q: string, limit: number): Promise<SourceItem[]> {
  const base = "https://servicos.lexml.gov.br/sru";
  const query = `mods.anywhere all "${q}"`;
  const url =
    `${base}?operation=searchRetrieve&version=1.2&recordSchema=mods` +
    `&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(query)}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`LexML ${res.status}`);
  const xml = await res.text();

  const items: SourceItem[] = [];
  const records = xml.match(/<recordData>[\s\S]*?<\/recordData>/g) || [];
  for (const r of records.slice(0, limit)) {
    const title = (r.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/\s+/g, " ").trim();
    const urlMatch = r.match(/<identifier[^>]*type="uri"[^>]*>(.*?)<\/identifier>/);
    const link = urlMatch?.[1];
    if (title) items.push({ source: "lexml", title, url: link });
  }
  return items;
}

/* -------- Handler -------- */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    if (!q) return NextResponse.json({ error: "Parâmetro ?q é obrigatório" }, { status: 400 });

    const source = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(20, Number(searchParams.get("limit") || "5")));

    const tasks: Promise<SourceItem[]>[] = [];
    if (source === "openalex" || source === "all") tasks.push(fetchOpenAlex(q, limit).catch(() => []));
    if (source === "scielo" || source === "all") tasks.push(fetchSciELO(q, limit).catch(() => []));
    if (source === "lexml" || source === "all") tasks.push(fetchLexML(q, limit).catch(() => []));

    const items = (await Promise.all(tasks)).flat();
    return NextResponse.json({ query: q, items }, { headers: { "Cache-Control": "no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
