"use client";

import React, { useMemo, useState } from "react";

type SourceKey =
  | "all"
  | "openalex"
  | "scielo"
  | "lexml"
  | "semanticscholar"
  | "serpapi_scholar"
  | "perplexity"
  | "openai_web";

type Item = {
  source: SourceKey | string;
  title: string;
  url?: string;
  year?: number;
  authors?: string[];
  snippet?: string;
  extra?: any;
};

const SOURCE_OPTIONS: { key: SourceKey; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "openalex", label: "OpenAlex" },
  { key: "scielo", label: "SciELO" },
  { key: "lexml", label: "LexML (com filtros)" },
  { key: "semanticscholar", label: "Semantic Scholar" },
  { key: "serpapi_scholar", label: "Google Scholar (SerpAPI)" },
  { key: "perplexity", label: "Perplexity" },
  { key: "openai_web", label: "OpenAI Web" },
];

export default function SourcesPage() {
  const [q, setQ] = useState("Legislação Educacional");
  const [source, setSource] = useState<SourceKey>("all");
  const [limit, setLimit] = useState(5);

  // Filtros LexML
  const [term, setTerm] = useState("Legislação Educacional");
  const [tipoDocumento, setTipoDocumento] = useState("Legislação");
  const [numero, setNumero] = useState("");
  const [ano, setAno] = useState("2000-2025");
  const [localidade, setLocalidade] = useState("");
  const [autoridade, setAutoridade] = useState("");
  const [excluir, setExcluir] = useState("");

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [respMeta, setRespMeta] = useState<{ ok: boolean; count: number; source: string; query: string } | null>(null);

  const isLexml = useMemo(() => source === "lexml", [source]);

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setItems([]);
    setErrors([]);
    setRespMeta(null);

    try {
      const params = new URLSearchParams();
      params.set("source", source);

      if (isLexml) {
        if (term) params.set("term", term);
        if (tipoDocumento) params.set("tipo_documento", tipoDocumento);
        if (numero) params.set("numero", numero);
        if (ano) params.set("ano", ano);
        if (localidade) params.set("localidade", localidade);
        if (autoridade) params.set("autoridade", autoridade);
        if (excluir) params.set("excluir", excluir);
      } else {
        if (q) params.set("q", q);
      }

      params.set("limit", String(limit));

      const url = `/api/sources?${params.toString()}`;
      const r = await fetch(url, { cache: "no-store" });
      const j = await r.json();

      setRespMeta({ ok: j?.ok ?? false, count: j?.count ?? 0, source: j?.source ?? "", query: j?.query ?? "" });
      setItems(j?.items ?? []);
      setErrors(j?.errors ?? []);
    } catch (err: any) {
      setErrors([`client_err_${err?.message || "x"}`]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold mb-4">Teste de Fontes</h1>

      <form onSubmit={runSearch} className="space-y-4 rounded-lg border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="flex flex-col">
            <span className="text-sm text-gray-600 mb-1">Fonte</span>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as SourceKey)}
              className="border rounded px-3 py-2"
            >
              {SOURCE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col">
            <span className="text-sm text-gray-600 mb-1">Limite</span>
            <input
              type="number"
              min={1}
              max={10}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="border rounded px-3 py-2"
            />
          </label>

          {!isLexml && (
            <label className="flex flex-col md:col-span-1">
              <span className="text-sm text-gray-600 mb-1">Consulta (q)</span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ex.: Legislação Educacional"
                className="border rounded px-3 py-2"
              />
            </label>
          )}
        </div>

        {isLexml && (
          <fieldset className="border rounded-md p-4 space-y-3">
            <legend className="text-sm font-medium">Filtros LexML (SRU/DC)</legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="flex flex-col">
                <span className="text-sm text-gray-600 mb-1">term</span>
                <input value={term} onChange={(e) => setTerm(e.target.value)} className="border rounded px-3 py-2" />
              </label>

              <label className="flex flex-col">
                <span className="text-sm text-gray-600 mb-1">tipo_documento</span>
                <input
                  value={tipoDocumento}
                  onChange={(e) => setTipoDocumento(e.target.value)}
                  placeholder='ex.: "Legislação", "Jurisprudência"'
                  className="border rounded px-3 py-2"
                />
              </label>

              <label className="flex flex-col">
                <span className="text-sm text-gray-600 mb-1">numero</span>
                <input value={numero} onChange={(e) => setNumero(e.target.value)} className="border rounded px-3 py-2" />
              </label>

              <label className="flex flex-col">
                <span className="text-sm text-gray-600 mb-1">ano</span>
                <input
                  value={ano}
                  onChange={(e) => setAno(e.target.value)}
                  placeholder='ex.: "2020" ou "2010-2015"'
                  className="border rounded px-3 py-2"
                />
              </label>

              <label className="flex flex-col">
                <span className="text-sm text-gray-600 mb-1">localidade</span>
                <input
                  value={localidade}
                  onChange={(e) => setLocalidade(e.target.value)}
                  className="border rounded px-3 py-2"
                />
              </label>

              <label className="flex flex-col">
                <span className="text-sm text-gray-600 mb-1">autoridade</span>
                <input
                  value={autoridade}
                  onChange={(e) => setAutoridade(e.target.value)}
                  className="border rounded px-3 py-2"
                />
              </label>

              <label className="flex flex-col md:col-span-2">
                <span className="text-sm text-gray-600 mb-1">excluir</span>
                <input
                  value={excluir}
                  onChange={(e) => setExcluir(e.target.value)}
                  placeholder='palavras (separe por vírgula)'
                  className="border rounded px-3 py-2"
                />
              </label>
            </div>
          </fieldset>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="bg-black text-white rounded px-4 py-2 disabled:opacity-60"
          >
            {loading ? "Buscando..." : "Buscar"}
          </button>
          <button
            type="button"
            className="border rounded px-4 py-2"
            onClick={() => {
              setItems([]);
              setErrors([]);
              setRespMeta(null);
            }}
          >
            Limpar
          </button>
        </div>
      </form>

      {respMeta && (
        <div className="mt-5 text-sm text-gray-700">
          <div>
            <b>ok:</b> {String(respMeta.ok)} | <b>count:</b> {respMeta.count} | <b>source:</b>{" "}
            {respMeta.source} | <b>query:</b> {respMeta.query}
          </div>
        </div>
      )}

      {errors?.length > 0 && (
        <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-semibold mb-1">Erros reportados pela API</div>
          <ul className="list-disc pl-5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        {items.length === 0 ? (
          <p className="text-gray-500">Sem itens.</p>
        ) : (
          <ul className="space-y-4">
            {items.map((it, i) => (
              <li key={i} className="rounded-md border p-4">
                <div className="text-xs text-gray-500 mb-1">{it.source}</div>
                <div className="font-medium">
                  {it.url ? (
                    <a href={it.url} target="_blank" className="underline hover:no-underline">
                      {it.title || it.url}
                    </a>
                  ) : (
                    it.title
                  )}
                </div>
                <div className="text-sm text-gray-700 mt-1">
                  {it.year ? <span className="mr-2">({it.year})</span> : null}
                  {it.authors?.length ? <span>{it.authors.join("; ")}</span> : null}
                </div>
                {it.snippet && <div className="text-sm text-gray-600 mt-2">{it.snippet}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
