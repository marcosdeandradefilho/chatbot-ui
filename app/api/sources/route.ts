// app/api/sources/route.ts

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// Use Node.js em vez de Edge para evitar limitações de rede/parsers
export const runtime = "nodejs";

type Item = {
  source: "openalex" | "scielo" | "lexml";
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

// ---------- OpenAlex ----------
async function fetchOpenAlex(q: string, limit: number) {
  const mail = encodeURIComponent(email() || "contato@example.com");
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(
    q
  )}&per-page=${limit}&mailto=${mail}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return { items: [] as Item[], error: `openalex_${r.status}` };

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
      extra: { cited_by_count: w?.cited_by_count },
    }));

    return { items };
  } catch (e: any) {
    return { items: [] as Item[], error: `openalex_err_${e?.message || "x"}` };
  }
}

// ---------- SciELO (API de busca pública) ----------
async function fetchScielo(q: string, limit: number) {
  // A API pública de busca é esta; funciona melhor que articlemeta pra pesquisa
  const url = `https://search.scielo.org/api/v1/?q=${encodeURIComponent(
    q
  )}&lang=pt&count=${limit}&output=site&format=json`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
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

// ---------- LexML (SRU + MODS) ----------
function parseLexml(xml: string, limit: number): Item[] {
  const out: Item[] = [];
  const rec = /<record\b[\s\S]*?<\/record>/gi;
  let m: RegExpExecArray | null;
  while ((m = rec.exec(xml)) && out.length < limit) {
    const chunk = m[0];
    const title =
      chunk.match(/<mods:title>(.*?)<\/mods:title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const url =
      chunk.match(/<identifier[^>]*type="uri"[^>]*>(.*?)<\/identifier>/i)?.[1] || "";
    const y = chunk.match(/<mods:dateIssued>(\d{4})/i)?.[1];
    if (title) out.push({ source: "lexml", title, url, year: y ? Number(y) : undefined });
  }
  return out;
}

async function fetchLexml(q: string, limit: number) {
  const url = `https://servicos.lexml.gov.br/sru/?operation=searchRetrieve&version=1.2&recordSchema=mods&maximumRecords=${limit}&startRecord=1&query=${encodeURIComponent(
    q
  )}`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/xml" },
      cache: "no-store",
    });
    if (!r.ok) return { items: [] as Item[], error: `lexml_${r.status}` };

    const xml = await r.text();
    return { items: parseLexml(xml, limit) };
  } catch (e: any) {
    return { items: [] as Item[], error: `lexml_err_${e?.message || "x"}` };
  }
}

// ---------- Handler ----------
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const src = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(10, Number(searchParams.get("limit")) || 5));

    if (!q) return NextResponse.json({ ok: false, error: "missing_query", items: [] }, { status: 400 });

    const tasks: Promise<{ items: Item[]; error?: string }>[] = [];
    if (src === "all" || src === "openalex") tasks.push(fetchOpenAlex(q, limit));
    if (src === "all" || src === "scielo") tasks.push(fetchScielo(q, limit));
    if (src === "all" || src === "lexml") tasks.push(fetchLexml(q, limit));

    const results = await Promise.all(tasks);
    const items = results.flatMap((r) => r.items);
    const errors = results.map((r) => r.error).filter(Boolean) as string[];

    return NextResponse.json(
      { ok: true, query: q, source: src, count: items.length, errors, items: cleanClone(items) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: any) {
    // Nunca mostra a tela branca: sempre responde JSON
    return NextResponse.json({ ok: false, error: `fatal_${e?.message || "unknown"}` }, { status: 500 });
  }
}
