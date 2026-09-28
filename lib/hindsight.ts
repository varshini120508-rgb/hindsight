/**
 * Hindsight Memory Client Wrapper
 * Uses real Hindsight API endpoints (retain, recall, reflect, banks)
 * Includes graceful local fallback in case HINDSIGHT_API_KEY is not set or network is offline.
 */

export interface MemoryFact {
  id: string;
  text: string;
  context?: string;
  score?: number;
  occurred_start?: string;
  metadata?: Record<string, string>;
}

export interface RecallResult {
  query: string;
  results: MemoryFact[];
  rawText?: string;
}

export interface ReflectResult {
  text: string;
  basedOn?: MemoryFact[];
}

export interface RetainedMemoryInput {
  content: string;
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  timestamp?: string;
}

// In-memory fallback store when Hindsight Cloud is unreachable or missing API key
const fallbackBankStore: Record<string, Array<{ text: string; context?: string; timestamp: string; metadata?: Record<string, string> }>> = {};

export class HindsightService {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = (process.env.HINDSIGHT_BASE_URL || "https://api.hindsight.vectorize.io").replace(/\/$/, "");
    this.apiKey = process.env.HINDSIGHT_API_KEY || "";
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "recall-agent/1.0.0",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Create or configure a memory bank for a customer or global scope.
   */
  async createBank(
    bankId: string,
    options: {
      name?: string;
      reflectMission?: string;
      dispositionEmpathy?: number;
    } = {}
  ): Promise<boolean> {
    if (!fallbackBankStore[bankId]) {
      fallbackBankStore[bankId] = [];
    }

    if (!this.apiKey) {
      return true;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/default/banks/${bankId}`, {
        method: "PUT",
        headers: this.getHeaders(),
        body: JSON.stringify({
          name: options.name || bankId,
          reflect_mission: options.reflectMission || "Helpful customer support agent with memory",
          disposition_empathy: options.dispositionEmpathy ?? 5,
        }),
      });
      return response.ok;
    } catch (error) {
      console.warn(`[Hindsight] createBank network warning for ${bankId}, using local bank:`, error);
      return true;
    }
  }

  /**
   * Store a single or multiple memories into a bank.
   */
  async retain(
    bankId: string,
    content: string | RetainedMemoryInput,
    metadata?: Record<string, string>
  ): Promise<boolean> {
    const memoryItem: RetainedMemoryInput = typeof content === "string"
      ? { content, metadata, timestamp: new Date().toISOString() }
      : { ...content, timestamp: content.timestamp || new Date().toISOString() };

    // Always keep fallback updated
    if (!fallbackBankStore[bankId]) {
      fallbackBankStore[bankId] = [];
    }
    fallbackBankStore[bankId].push({
      text: memoryItem.content,
      context: memoryItem.context,
      timestamp: memoryItem.timestamp!,
      metadata: memoryItem.metadata,
    });

    if (!this.apiKey) {
      return true;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/default/banks/${bankId}/retain`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          items: [
            {
              content: memoryItem.content,
              context: memoryItem.context,
              metadata: memoryItem.metadata,
              tags: memoryItem.tags,
              timestamp: memoryItem.timestamp,
            },
          ],
        }),
      });
      return response.ok;
    } catch (error) {
      console.warn(`[Hindsight] retain warning for bank ${bankId}:`, error);
      return true; // Soft fail, local fallback saved
    }
  }

  /**
   * Retain multiple memories in batch.
   */
  async retainBatch(bankId: string, items: RetainedMemoryInput[]): Promise<boolean> {
    for (const item of items) {
      await this.retain(bankId, item);
    }
    return true;
  }

  /**
   * Recall memories matching a query.
   */
  async recall(
    bankId: string,
    query: string,
    options?: { budget?: "low" | "mid" | "high"; tags?: string[] }
  ): Promise<RecallResult> {
    if (this.apiKey) {
      try {
        const response = await fetch(`${this.baseUrl}/v1/default/banks/${bankId}/recall`, {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            query,
            budget: options?.budget || "mid",
            tags: options?.tags,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const results: MemoryFact[] = (data.results || []).map((r: any, idx: number) => ({
            id: r.id || `rec-${idx}`,
            text: r.text || r.content || "",
            context: r.context || "",
            score: r.score ?? 0.85,
            occurred_start: r.occurred_start || r.timestamp,
            metadata: r.metadata,
          }));

          return {
            query,
            results,
            rawText: results.map((r) => r.text).join("\n"),
          };
        }
      } catch (error) {
        console.warn(`[Hindsight] recall network warning for bank ${bankId}:`, error);
      }
    }

    // Local fallback search algorithm
    const store = fallbackBankStore[bankId] || [];
    const queryLower = query.toLowerCase();
    const queryTokens = queryLower.split(/\W+/).filter(Boolean);

    const scored = store.map((mem, index) => {
      const textLower = mem.text.toLowerCase();
      let matchCount = 0;
      for (const token of queryTokens) {
        if (token.length > 2 && textLower.includes(token)) {
          matchCount++;
        }
      }
      const score = queryTokens.length ? matchCount / queryTokens.length : 0.5;
      return {
        id: `local-mem-${index}`,
        text: mem.text,
        context: mem.context || "Past interaction",
        score: score > 0 ? Math.min(0.95, 0.5 + score * 0.5) : 0.4,
        occurred_start: mem.timestamp,
        metadata: mem.metadata,
      };
    });

    // Sort by score or return all if specific issue match
    const filtered = scored.filter((s) => s.score >= 0.4).sort((a, b) => b.score - a.score);
    const finalResults = filtered.length > 0 ? filtered : scored.slice(-5).reverse();

    return {
      query,
      results: finalResults,
      rawText: finalResults.map((r) => r.text).join("\n"),
    };
  }

  /**
   * Reflect and synthesize knowledge from bank's identity and memories.
   */
  async reflect(
    bankId: string,
    query: string,
    options?: { budget?: "low" | "mid" | "high" }
  ): Promise<ReflectResult> {
    if (this.apiKey) {
      try {
        const response = await fetch(`${this.baseUrl}/v1/default/banks/${bankId}/reflect`, {
          method: "POST",
          headers: this.getHeaders(),
          body: JSON.stringify({
            query,
            budget: options?.budget || "low",
          }),
        });

        if (response.ok) {
          const data = await response.json();
          return {
            text: data.text || data.answer || "Reflection completed.",
            basedOn: data.based_on || [],
          };
        }
      } catch (error) {
        console.warn(`[Hindsight] reflect warning for bank ${bankId}:`, error);
      }
    }

    // Fallback reflection using local memories
    const recallRes = await this.recall(bankId, query);
    const memorySummary = recallRes.results.map((r) => `- ${r.text}`).join("\n");
    return {
      text: memorySummary
        ? `Based on memory records for ${bankId}:\n${memorySummary}`
        : `No explicit prior reflection found for ${bankId}.`,
      basedOn: recallRes.results,
    };
  }

  /**
   * Clear or reset a bank's local fallback store (useful for clean demo resets).
   */
  clearLocalBank(bankId: string) {
    fallbackBankStore[bankId] = [];
  }
}

export const hindsight = new HindsightService();
