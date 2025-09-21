import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

// URLs de fallback (caso a env não esteja setada)
const OPENALEX = process.env.OPENALEX_API_URL || "https://api.openalex.org/";
const SCIELO   = process.env.SCIELO_API_URL   || "https://articlemeta.scielo.org/api/v1/";
const LEXML    = process.env.LEXML_SRU_URL    || "https://servicos.lexml.gov.br/sru/";

// helper para responder JSON sempre
function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const source = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(parseInt(searchParams.get("limit") || "5", 10) || 5, 20));

    if (!q) return json({ ok: false, error: "Informe o parâmetro q" }, 400);

    const promises: Promise<any[]>[] = [];
    if (source === "openalex" || source === "all") promises.push(fetchOpenAlex(q, limit));
    if (source === "scielo"   || source === "all") promises.push(fetchSciELO(q, limit));
    if (source === "lexml"    || source === "all") promises.push(fetchLexML(q, limit));

    // NUNCA falha geral: o que der erro é ignorado
    const settled = await Promise.allSettled(promises);
    const items = settled.flatMap(s => (s.status === "fulfilled" ? s.value : []));

    return json({ ok: true, query: q, source, count: items.length, items });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || "server_error" }, 500);
  }
}

// ------------------ fontes ------------------

async function fetchOpenAlex(q: string, limit: number): Promise<any[]> {
  // OpenAlex aceita identificação via ?mailto=... (funciona na Edge)
  const mail = (process.env.CONTACT_MAIL || "").trim();
  const mailParam = mail ? `&mailto=${encodeURIComponent(mail)}` : "";
  const url = `${OPENALEX}works?search=${encodeURIComponent(q)}&per-page=${limit}${mailParam}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`openalex_${res.status}`);

  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.slice(0, limit).map((w: any) => ({
    source: "openalex",
    title: w?.title || "",
    url: w?.id || "",
    year: w?.publication_year ?? null,
    authors: (w?.authorships || []).map((a: any) => a?.author?.display_name).filter(Boolean),
    abstract:
      w?.abstract_inverted_index
        ? Object.keys(w.abstract_inverted_index).slice(0, 60).join(" ")
        : "",
  }));
}

async function fetchSciELO(q: string, limit: number): Promise<any[]> {
  // Busca tolerante (título OU resumo). A API do ArticleMeta responde JSON.
  const query = `ti:"${q}" OR ab:"${q}"`;
  const url = `${SCIELO}article/?q=${encodeURIComponent(query)}&limit=${limit}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`scielo_${res.status}`);

  const data = await res.json();
  const arr = Array.isArray(data?.objects) ? data.objects : (Array.isArray(data) ? data : []);
  return arr.slice(0, limit).map((it: any) => ({
    source: "scielo",
    title: it?.title || it?.title_translated || "",
    url: it?.pid || it?.doi || "",
    year: it?.publication_year || it?.year || null,
    authors: it?.authors || it?.author || [],
    abstract: it?.abstract || it?.abstract_translated || "",
  }));
}

async function fetchLexML(q: string, limit: number): Promise<any[]> {
  // SRU do LexML (retorna XML). Extração simples com RegExp.
  const url = `${LEXML}?operation=searchRetrieve&version=1.2&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(q)}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`lexml_${res.status}`);

  const xml = await res.text();
  const items: any[] = [];

  const recordRe = /<record>[\s\S]*?<recordData>[\s\S]*?<\/recordData>[\s\S]*?<\/record>/gi;
  const titleRe = /<mods:title>([^<]+)<\/mods:title>/i;
  const idRe = /<mods:identifier[^>]*>([^<]+)<\/mods:identifier>/i;

  let m: RegExpExecArray | null;
  while ((m = recordRe.exec(xml)) && items.length < limit) {
    const chunk = m[0];
    const title = (titleRe.exec(chunk)?.[1] || "").trim();
    const id = (idRe.exec(chunk)?.[1] || "").trim();
    if (title) items.push({ source: "lexml", title, url: id });
  }
  return items;
}
