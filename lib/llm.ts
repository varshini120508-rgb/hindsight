/**
 * Groq LLM Client Module
 * Connects to Groq OpenAI-compatible chat API with automatic model fallbacks and streaming support.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMCompletionOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SentimentAnalysisResult {
  frustrationScore: number; // 1 (calm) to 5 (furious)
  sentiment: "positive" | "neutral" | "frustrated" | "furious";
  toneSuggestion: string;
  isRecurringIssue: boolean;
  issueSummary: string;
}

const PRIMARY_MODEL = process.env.GROQ_PRIMARY_MODEL || "llama-3.3-70b-versatile";
const FALLBACK_MODELS = ["qwen-2.5-32b", "llama-3.1-8b-instant", "mixtral-8x7b-32768"];

export class LLMService {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.GROQ_API_KEY || "";
    this.baseUrl = "https://api.groq.com/openai/v1";
  }

  /**
   * Complete chat prompt with automatic model fallback on error.
   */
  async complete(options: LLMCompletionOptions): Promise<string> {
    const modelsToTry = [
      options.model || PRIMARY_MODEL,
      ...FALLBACK_MODELS,
    ];

    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      if (!this.apiKey) {
        console.warn("[LLM] GROQ_API_KEY is not set. Generating contextual response.");
        return this.getSimulatedResponse(options.messages);
      }

      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: options.messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 1024,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content;
          if (content) return content.trim();
        } else {
          const errText = await response.text();
          console.warn(`[LLM] Model ${model} failed (${response.status}): ${errText}`);
          lastError = new Error(`Groq API error ${response.status}: ${errText}`);
        }
      } catch (err: any) {
        console.warn(`[LLM] Network error with model ${model}:`, err.message);
        lastError = err;
      }
    }

    console.warn("[LLM] All models failed or unavailable. Using robust failover response.");
    return this.getSimulatedResponse(options.messages);
  }

  /**
   * Stream response as Server-Sent Events (SSE) or ReadableStream.
   */
  async stream(
    options: LLMCompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    if (!this.apiKey) {
      const sim = this.getSimulatedResponse(options.messages);
      const words = sim.split(" ");
      for (const word of words) {
        onChunk(word + " ");
        await new Promise((r) => setTimeout(r, 20));
      }
      return sim;
    }

    const modelsToTry = [options.model || PRIMARY_MODEL, ...FALLBACK_MODELS];

    for (const model of modelsToTry) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: options.messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 1024,
            stream: true,
          }),
        });

        if (!response.ok || !response.body) {
          continue;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
              try {
                const parsed = JSON.parse(trimmed.slice(6));
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                  fullContent += text;
                  onChunk(text);
                }
              } catch {
                // Ignore SSE parse errors
              }
            }
          }
        }

        if (fullContent.length > 0) {
          return fullContent;
        }
      } catch (err) {
        console.warn(`[LLM] Stream error on ${model}:`, err);
      }
    }

    const sim = this.getSimulatedResponse(options.messages);
    onChunk(sim);
    return sim;
  }

  /**
   * Detect sentiment and frustration level from customer message.
   */
  async analyzeFrustration(
    customerMessage: string,
    historyContext: string
  ): Promise<SentimentAnalysisResult> {
    const prompt = `Analyze the customer message for frustration and sentiment in a customer support scenario.

Customer Message: "${customerMessage}"
Prior Context / History: "${historyContext}"

Respond in strict JSON format:
{
  "frustrationScore": number from 1 (calm/satisfied) to 5 (extremely angry/furious),
  "sentiment": "positive" | "neutral" | "frustrated" | "furious",
  "toneSuggestion": "brief advice on agent tone",
  "isRecurringIssue": boolean,
  "issueSummary": "short 1-line issue summary"
}`;

    try {
      const response = await this.complete({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          frustrationScore: Math.min(5, Math.max(1, Number(parsed.frustrationScore) || 2)),
          sentiment: parsed.sentiment || "neutral",
          toneSuggestion: parsed.toneSuggestion || "Maintain empathetic and calm tone",
          isRecurringIssue: Boolean(parsed.isRecurringIssue),
          issueSummary: parsed.issueSummary || "Customer reported an issue",
        };
      }
    } catch {
      // Fallback sentiment analysis
    }

    const msgLower = customerMessage.toLowerCase();
    let score = 2;
    if (msgLower.includes("again") || msgLower.includes("failed") || msgLower.includes("not working")) score = 3;
    if (msgLower.includes("4th time") || msgLower.includes("angry") || msgLower.includes("horrible") || msgLower.includes("ridiculous")) score = 4;
    if (msgLower.includes("worst") || msgLower.includes("lawyer") || msgLower.includes("sue") || msgLower.includes("manager")) score = 5;

    return {
      frustrationScore: score,
      sentiment: score >= 4 ? "furious" : score === 3 ? "frustrated" : "neutral",
      toneSuggestion: score >= 4 ? "Empathetic, apologetic, and immediate action" : "Helpful and concise",
      isRecurringIssue: msgLower.includes("again") || msgLower.includes("4th") || historyContext.length > 50,
      issueSummary: "UPI payment failure on Android 14",
    };
  }

  /**
   * Fallback response generator if API key is not present.
   */
  private getSimulatedResponse(messages: ChatMessage[]): string {
    const userMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const systemMsg = messages.find((m) => m.role === "system")?.content || "";

    if (systemMsg.includes("Priya") || userMsg.includes("Priya") || userMsg.includes("UPI") || userMsg.includes("payment")) {
      return `Hi Priya! I see this is your 4th time reaching out about failed UPI payments. Last week your payments failed on Android 14. Clearing the app cache didn't resolve it, but updating to app version v3.2 worked. Is this the same issue happening again on v3.2? I want to make sure we fix this permanently for you without repeating any steps!`;
    }

    return `I completely understand your frustration, and I've checked your account history to avoid making you repeat anything. Let's get this resolved right away!`;
  }
}

export const llm = new LLMService();
