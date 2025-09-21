import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(input: string | number | Date): string {
  const date = new Date(input)
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  })
}

export function getMediaTypeFromDataURL(dataURL: string): string | null {
  const matches = dataURL.match(/^data:([A-Za-z-+\/]+);base64/)
  return matches ? matches[1] : null
}

export function getBase64FromDataURL(dataURL: string): string | null {
  const matches = dataURL.match(/^data:[A-Za-z-+\/]+;base64,(.*)$/)
  return matches ? matches[1] : null
}
// ====== Novas integrações (corrigidas) ======

/** OpenAlex (sem chave; recomenda incluir um email de contato no header) */
export async function fetchOpenAlex(query: string) {
  const url = `${process.env.OPENALEX_API_URL}works?search=${encodeURIComponent(query)}&per-page=5`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": (process.env.CONTACT_MAIL ?? "contact@example.com")
    },
    // Importante no Edge Runtime
    cache: "no-store"
  });
  if (!res.ok) throw new Error("Erro na OpenAlex");
  return res.json();
}

/** SciELO ArticleMeta: /api/v1/article/?q=... retorna JSON */
export async function fetchSciELO(query: string) {
  // Busca simples por título OU resumo
  const q = `(title:"${query}" OR abstract:"${query}")`;
  const url = `${process.env.SCIELO_API_URL}article/?q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    cache: "no-store"
  });
  if (!res.ok) throw new Error("Erro na SciELO");
  return res.json();
}

/** LexML SRU (retorna XML em texto) */
export async function fetchLexML(query: string) {
  const url = `${process.env.LEXML_SRU_URL}?operation=searchRetrieve&version=1.2&query=${encodeURIComponent(query)}&maximumRecords=5`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Erro no LexML");
  return res.text(); // SRU responde XML
}

