// app/api/sources/route.ts
import { NextRequest, NextResponse } from "next/server";

// Use Node.js runtime (mais seguro para libs/regex/envs)
export const runtime = "nodejs";

// URLs a partir das suas ENV VARS (com fallback seguro)
const OPENALEX = (process.env.OPENALEX_API_URL || "https://api.openalex.org/").replace(/\/$/, "");
const SCIELO = (process.env.SCIELO_API_URL || "https://articlemeta.scielo.org/api/v1/").replace(/\/$/, "");
const LEXML  = (process.env.LEXML_SRU_URL  || "https://servicos.lexml.gov.br/sru/").replace(/\/$/, "");
const MAIL   = process.env.CONTACT_MAIL || "contato@example.com";

type Source = "openalex" | "scielo" | "lexml" | "all";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
function take<T>(arr: T[], limit: number) {
  return arr.slice(0, limit);
}

/* ----------------- OpenAlex ----------------- */
async function getOpenAlex(q: string, limit: number) {
  try {
    // OpenAlex recomenda incluir mailto no query string
    const url = `${OPENALEX}/works?search=${encodeURIComponent(q)}&per-page=${limit}&mailto=${encodeURIComponent(MAIL)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
    const data = await res.json();

    const items = (data?.results ?? []).map((w: any) => ({
      source: "openalex",
      title: w?.title ?? "",
      url: w?.id ?? "",
      year: w?.publication_year,
      authors: Array.isArray(w?.authorships)
        ? w.authorships.map((a: any) => a?.author?.display_name).filter(Boolean).join(", ")
        : undefined,
      abstract:
        w?.abstract_inverted_index
          ? Object.entries(w.abstract_inverted_index)
              .flatMap(([word, idxs]: [string, any]) => Array((idxs as number[]).length).fill(word))
              .join(" ")
          : undefined,
    }));

    return take(items, limit);
  } catch {
    return [];
  }
}

/* ----------------- SciELO (ArticleMeta) -----------------
   O ArticleMeta tem variações. Tentamos /search e caímos para /article.
---------------------------------------------------------- */
async function getSciELO(q: string, limit: number) {
  try {
    const base = SCIELO;
    // 1ª tentativa: endpoint de busca
    let res = await fetch(`${base}/search/?q=${encodeURIComponent(q)}&limit=${limit}`, { cache: "no-store" });

    // fallback: filtra por título no /article
    if (!res.ok) {
      res = await fetch(`${base}/article/?title=${encodeURIComponent(q)}&limit=${limit}`, { cache: "no-store" });
    }
    if (!res.ok) throw new Error(`SciELO ${res.status}`);

    const json = await res.json();
    const docs = Array.isArray(json) ? json : (json?.objects || json?.results || []);
    const items = (Array.isArray(docs) ? docs : []).map((d: any) => ({
      source: "scielo",
      title: d?.title ?? d?.titles?.[0]?.text ?? "",
      url: d?.url ?? d?.pid ?? d?.code ?? "",
      year: d?.year ?? d?.publication_year,
      authors: Array.isArray(d?.authors) ? d.authors.map((a: any) => a?.name).filter(Boolean).join(", ") : undefined,
      abstract: Array.isArray(d?.abstract)
        ? (d.abstract.find((x: any) => x?.lang === "pt")?.text ?? d.abstract[0]?.text)
        : d?.abstract,
    }));

    return take(items, limit);
  } catch {
    return [];
  }
}

/* ----------------- LexML (SRU XML) ----------------- */
async function getLexML(q: string, limit: number) {
  try {
    const url = `${LEXML}?operation=searchRetrieve&version=1.2&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(q)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`LexML ${res.status}`);

    const xml = await res.text();

    // Extrai cada <record>...</record>
    const records = xml.match(/<record>[\s\S]*?<\/record>/g) ?? [];
    const items = records.slice(0, limit).map((rec) => {
      const titleMatch =
        rec.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/) ||
        rec.match(/<title>([\s\S]*?)<\/title>/);
      const urlMatch =
        rec.match(/<identifier[^>]*>(https?:\/\/[^<]+)<\/identifier>/) ||
        rec.match(/<dc:identifier[^>]*>(https?:\/\/[^<]+)<\/dc:identifier>/);

      return {
        source: "lexml",
        title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "Sem título",
        url: urlMatch ? urlMatch[1] : "",
      };
    });

    return take(items, limit);
  } catch {
    return [];
  }
}

/* ----------------- Handler ----------------- */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  const source = (searchParams.get("source") || "all") as Source;
  const limit = clamp(parseInt(searchParams.get("limit") || "5", 10) || 5, 1, 20);

  if (!q) {
    return NextResponse.json({ ok: false, error: "Parâmetro obrigatório: q" }, { status: 400 });
  }

  const promises: Promise<any[]>[] = [];
  if (source === "all" || source === "openalex") promises.push(getOpenAlex(q, limit));
  if (source === "all" || source === "scielo")   promises.push(getSciELO(q, limit));
  if (source === "all" || source === "lexml")    promises.push(getLexML(q, limit));

  const results = await Promise.all(promises);
  const items = results.flat();

  return NextResponse.json({ ok: true, query: q, count: items.length, items });
}
