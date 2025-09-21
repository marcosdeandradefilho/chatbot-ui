// app/api/sources/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const OPENALEX = process.env.OPENALEX_API_URL ?? "https://api.openalex.org/";
const SCIELO = process.env.SCIELO_API_URL ?? "https://articlemeta.scielo.org/api/v1/";
const LEXML = process.env.LEXML_SRU_URL ?? "https://servicos.lexml.gov.br/sru/";
const CONTACT = process.env.CONTACT_MAIL ?? "contato@example.com";

type Item = {
  source: "openalex" | "scielo" | "lexml";
  title: string;
  url?: string;
  doi?: string;
  year?: number;
  authors?: string[];
  abstract?: string;
  extra?: Record<string, any>;
};

function okJson<T>(v: T) {
  return NextResponse.json(v, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const source = (searchParams.get("source") ?? "all").toLowerCase();
  const limit = Number(searchParams.get("limit") ?? "5");

  if (!q) return okJson({ query: "", items: [], warning: "parâmetro 'q' é obrigatório" });

  const tasks: Promise<Item[]>[] = [];

  if (source === "openalex" || source === "all") {
    tasks.push(fetchOpenAlex(q, limit).catch(() => []));
  }
  if (source === "scielo" || source === "all") {
    tasks.push(fetchScielo(q, limit).catch(() => []));
  }
  if (source === "lexml" || source === "all") {
    tasks.push(fetchLexml(q, limit).catch(() => []));
  }

  const results = (await Promise.all(tasks)).flat();
  return okJson({ query: q, items: results });
}

// -------- OpenAlex --------
async function fetchOpenAlex(q: string, limit: number): Promise<Item[]> {
  const url =
    `${OPENALEX.replace(/\/$/, "")}/works?search=${encodeURIComponent(q)}` +
    `&per-page=${limit}&mailto=${encodeURIComponent(CONTACT)}`;

  const res = await fetch(url, {
    headers: { "User-Agent": CONTACT },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`openalex ${res.status}`);

  const data = await res.json();
  const arr = Array.isArray(data.results) ? data.results : [];

  return arr.map((w: any) => ({
    source: "openalex",
    title: w.title || "",
    url: w.doi
      ? `https://doi.org/${String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`
      : w.primary_location?.landing_page_url,
    doi: w.doi ? String(w.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//, "") : undefined,
    year: w.publication_year,
    authors: (w.authorships || []).map((a: any) => a.author?.display_name).filter(Boolean),
    abstract: w.abstract_inverted_index ? invertIndex(w.abstract_inverted_index) : undefined,
    extra: { openalex_id: w.id },
  }));
}

function invertIndex(inv: Record<string, number[]>) {
  const tokens: string[] = [];
  Object.entries(inv).forEach(([word, positions]) => {
    (positions as number[]).forEach((pos) => {
      tokens[pos] = word;
    });
  });
  return tokens.join(" ");
}

// -------- SciELO (ArticleMeta) --------
// Pesquisa por título: /article/?title=<q>&format=json&limit=<n>
async function fetchScielo(q: string, limit: number): Promise<Item[]> {
  const url =
    `${SCIELO.replace(/\/$/, "")}/article/?title=${encodeURIComponent(q)}` +
    `&format=json&limit=${limit}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`scielo ${res.status}`);

  const data = await res.json();
  const arr: any[] = Array.isArray(data) ? data : Array.isArray(data.objects) ? data.objects : [];

  return arr.slice(0, limit).map((it: any) => ({
    source: "scielo",
    title: it.title || it.title_translated || "",
    url: it.doi ? `https://doi.org/${it.doi}` : it.url || it.link || undefined,
    doi: it.doi,
    year: Number(it.publication_year || it.year || (it.publication_date || "").slice(0, 4)),
    authors: (it.authors || it.author || [])
      .map(
        (a: any) => a.name || a.fullname || `${a.surname || ""} ${a.given_names || ""}`.trim()
      )
      .filter(Boolean),
    abstract: it.abstract || it.abstract_lang || undefined,
    extra: { scielo_pid: it.pid || it.code },
  }));
}

// -------- LexML (SRU) --------
async function fetchLexml(q: string, limit: number): Promise<Item[]> {
  const url =
    `${LEXML}?operation=searchRetrieve&version=1.2` +
    `&maximumRecords=${limit}&startRecord=1&recordSchema=mods&query=${encodeURIComponent(q)}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`lexml ${res.status}`);

  const xml = await res.text();
  const items: Item[] = [];

  // Extração simples de título e URL
  const entryRe =
    /<record>\s*<recordSchema>mods<\/recordSchema>[\s\S]*?<mods:mods[^>]*>([\s\S]*?)<\/mods:mods>[\s\S]*?<\/record>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) && items.length < limit) {
    const chunk = m[1];
    const title = (chunk.match(/<mods:title>([^<]+)<\/mods:title>/) || [, ""])[1];
    const url = (chunk.match(/<mods:identifier[^>]*type="uri"[^>]*>([^<]+)<\/mods:identifier>/) || [
      ,
      "",
    ])[1];
    items.push({ source: "lexml", title, url });
  }

  return items;
}
