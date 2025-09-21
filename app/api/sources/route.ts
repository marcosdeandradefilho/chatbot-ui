// app/api/sources/route.ts
import { NextRequest, NextResponse } from "next/server";
import { fetchOpenAlex, fetchSciELO, fetchLexML } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "edge";

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

type ApiResponse = {
  query: string;
  items: SourceItem[];
};

function mapOpenAlex(data: any, limit: number): SourceItem[] {
  const arr: any[] = Array.isArray(data?.results) ? data.results : [];
  return arr.slice(0, limit).map((w) => ({
    source: "openalex",
    title: w?.display_name ?? w?.title ?? "(sem título)",
    url:
      w?.primary_location?.source?.homepage_url ||
      w?.open_access?.oa_url ||
      w?.id,
    doi: w?.doi ?? undefined,
    year: w?.publication_year ?? undefined,
    authors:
      (w?.authorships || [])
        .map((a: any) => a?.author?.display_name)
        .filter(Boolean) || [],
  }));
}

function mapSciELO(data: any, limit: number): SourceItem[] {
  const arr: any[] = Array.isArray(data?.objects) ? data.objects : Array.isArray(data) ? data : [];
  return arr.slice(0, limit).map((a) => ({
    source: "scielo",
    title:
      a?.titles?.[0]?.title ||
      a?.title ||
      a?.article_title ||
      "(sem título)",
    url:
      a?.links?.[0]?.url ||
      a?.link ||
      a?.url ||
      (a?.pid ? `https://search.scielo.org/?q=${encodeURIComponent(a?.pid)}` : undefined),
    doi: a?.doi ?? undefined,
    year: a?.publication_year ?? a?.year ?? undefined,
    authors:
      (a?.authors || a?.contrib || [])
        .map((au: any) =>
          au?.surname
            ? `${au?.given_names ?? ""} ${au?.surname}`.trim()
            : au?.name
        )
        .filter(Boolean) || [],
    abstract:
      a?.abstract ||
      a?.abstracts?.[0]?.text ||
      undefined,
    extra: { scielo_pid: a?.pid ?? a?.scielo_pid },
  }));
}

function decodeHtml(s?: string) {
  return (s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'");
}

function mapLexML(xml: string, limit: number): SourceItem[] {
  const items: SourceItem[] = [];
  const re =
    /<recordData>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?(?:<identifier[^>]*>(.*?)<\/identifier>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && items.length < limit) {
    items.push({
      source: "lexml",
      title: decodeHtml(m[1]) || "(sem título)",
      url: m[2] ? decodeHtml(m[2]) : undefined,
    });
  }
  return items;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const source = (searchParams.get("source") || "all").toLowerCase();
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") || "5", 10), 1),
      10
    );

    if (!q) {
      return NextResponse.json(
        { error: "Passe o parâmetro ?q= com o termo da busca." },
        { status: 400 }
      );
    }

    const tasks: Promise<SourceItem[]>[] = [];

    if (source === "openalex" || source === "all") {
      tasks.push(
        fetchOpenAlex(q).then((d: any) => mapOpenAlex(d, limit)).catch(() => [])
      );
    }
    if (source === "scielo" || source === "all") {
      tasks.push(
        fetchSciELO(q).then((d: any) => mapSciELO(d, limit)).catch(() => [])
      );
    }
    if (source === "lexml" || source === "all") {
      tasks.push(
        fetchLexML(q).then((xml: string) => mapLexML(xml, limit)).catch(() => [])
      );
    }

    const settled = await Promise.allSettled(tasks);
    const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    const payload: ApiResponse = { query: q, items };
    return NextResponse.json(payload, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: "Falha ao processar a busca." },
      { status: 500 }
    );
  }
}
