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
// ====== Novas integrações ======

export async function fetchOpenAlex(query: string) {
  const url = `${process.env.OPENALEX_API_URL}works?search=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Erro na OpenAlex");
  return res.json();
}

export async function fetchSciELO(query: string) {
  const url = `${process.env.SCIELO_API_URL}search?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Erro na SciELO");
  return res.json();
}

export async function fetchLexML(query: string) {
  const url = `${process.env.LEXML_SRU_URL}?operation=searchRetrieve&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Erro no LexML");
  return res.text(); // LexML responde em XML
}
