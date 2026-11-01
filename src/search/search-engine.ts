import type { Item } from "../domain/types.js";
import { cosine, type Embedder } from "./embeddings.js";
import { synonymStems } from "./synonyms.js";
import { similarity, stems, tokenize } from "./text.js";

export interface SearchHit {
  item: Item;
  score: number;
  /** Which signal produced the score — handy for debugging and the README demo. */
  via: "lexical" | "semantic";
}

export interface SearchQuery {
  text: string;
  /** Extra related words (from the LLM) that should also match, with a lower weight. */
  related?: string[];
}

const MIN_SCORE = 0.34;

/** Best match strength of a query stem against an item's stems: exact > prefix > fuzzy. */
function matchStrength(term: string, itemStems: string[]): number {
  let best = 0;
  for (const s of itemStems) {
    if (s === term) return 1;
    if (term.length >= 4 && s.length >= 4 && (s.startsWith(term) || term.startsWith(s))) best = Math.max(best, 0.85);
    else if (term.length >= 4) {
      const sim = similarity(term, s);
      if (sim >= 0.55) best = Math.max(best, sim * 0.8);
    }
  }
  return best;
}

/**
 * Hybrid retrieval over a user's items: stemmed lexical matching with a domain thesaurus and
 * typo tolerance, optionally fused with embedding similarity. The candidate set is the user's
 * own items, which keeps this exact and simple at prototype scale.
 */
export class SearchEngine {
  constructor(private readonly embedder: Embedder | null = null) {}

  get semantic(): boolean {
    return this.embedder !== null;
  }

  lexicalScore(item: Item, q: SearchQuery): number {
    const original = stems(q.text);
    if (original.length === 0) return 0;
    const titleStems = stems(item.title);
    const noteStems = stems(`${item.notes ?? ""} ${item.sourceText ?? ""}`);
    const strength = (term: string) =>
      Math.max(matchStrength(term, titleStems), matchStrength(term, noteStems) * 0.8);

    // Every query word must be covered by itself or a synonym; the score is the mean coverage.
    let total = 0;
    for (const o of original) {
      let best = strength(o);
      for (const syn of synonymStems(o)) best = Math.max(best, strength(syn) * 0.75);
      total += best;
    }
    const direct = total / original.length;

    // LLM-provided related terms act as alternative phrasings of the whole query.
    let related = 0;
    for (const r of q.related ?? []) {
      const rs = stems(r);
      if (rs.length === 0) continue;
      related = Math.max(related, (rs.reduce((acc, s) => acc + strength(s), 0) / rs.length) * 0.7);
    }
    return Math.max(direct, related);
  }

  async search(items: Item[], q: SearchQuery, vectors?: Map<string, number[]>): Promise<SearchHit[]> {
    const hits = new Map<string, SearchHit>();
    for (const item of items) {
      const score = this.lexicalScore(item, q);
      if (score >= MIN_SCORE) hits.set(item.id, { item, score, via: "lexical" });
    }
    if (this.embedder && vectors && vectors.size > 0 && tokenize(q.text).length > 0) {
      try {
        const [qv] = await this.embedder.embed([[q.text, ...(q.related ?? [])].join(", ")]);
        for (const item of items) {
          const v = vectors.get(item.id);
          if (!v) continue;
          // Map cosine (≈0.2 unrelated … ≈0.8 same meaning) onto the lexical scale.
          const sem = Math.max(0, (cosine(qv, v) - 0.3) / 0.45);
          const prev = hits.get(item.id);
          if (sem >= MIN_SCORE && (!prev || sem > prev.score)) hits.set(item.id, { item, score: Math.min(1, sem), via: "semantic" });
        }
      } catch (err) {
        console.warn("[search] embeddings unavailable, lexical only:", (err as Error).message);
      }
    }
    return [...hits.values()].sort((a, b) => b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt));
  }

  async embedItem(item: Item): Promise<number[] | null> {
    if (!this.embedder) return null;
    const [v] = await this.embedder.embed([[item.title, item.notes].filter(Boolean).join(". ")]);
    return v ?? null;
  }
}

