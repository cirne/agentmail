import OpenAI from "openai";
import { config } from "~/lib/config";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  try {
    if (!openaiClient && config.openai.apiKey) {
      openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
    }
    return openaiClient;
  } catch {
    return null;
  }
}

export interface LLMInferenceResult {
  firstname: string | null;
  lastname: string | null;
  company: string | null;
  type: "person" | "group" | "company" | "other";
}

/**
 * Use LLM (GPT-4.1 nano) to infer name components, company, and type from email address.
 * Returns null if LLM is not available or inference fails.
 * 
 * @param address Email address to infer from
 * @returns Inference result with firstname, lastname, company, and type, or null if unavailable
 */
export async function inferNameFromAddressLLM(
  address: string
): Promise<LLMInferenceResult | null> {
  const client = getOpenAIClient();
  if (!client) {
    return null;
  }

  const localPart = address.split("@")[0];
  const domain = address.split("@")[1] || "";
  
  // Extract base domain (remove subdomains for company inference)
  // e.g., "mail.greenlonghorninc.com" -> "greenlonghorninc.com"
         // Extract base domain (remove subdomains for company inference)
         // e.g., "mail.greenlonghorninc.com" -> "greenlonghorninc.com"
         // Note: We pass the full domain to LLM, which can handle subdomains
  
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [
        {
          role: "system",
          content: "Guess firstname, lastname, company, type from email. Respond: firstname|lastname|company|type (use null for missing, type: person/group/company/other). Infer company name from domain if work email (e.g., greenlonghorninc.com -> Green Longhorn Inc).",
        },
        {
          role: "user",
          content: `${localPart}@${domain}`,
        },
      ],
      max_tokens: 50,
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    // Parse response: "firstname|lastname|company|type"
    const parts = content.split("|");
    if (parts.length !== 4) return null;

    const firstnameStr = parts[0].trim();
    const lastnameStr = parts[1].trim();
    const companyStr = parts[2].trim();
    const typeStr = parts[3].trim().toLowerCase();

    const firstname = firstnameStr === "null" || firstnameStr === "" ? null : firstnameStr;
    const lastname = lastnameStr === "null" || lastnameStr === "" ? null : lastnameStr;
    const company = companyStr === "null" || companyStr === "" ? null : companyStr;
    const type = ["person", "group", "company", "other"].includes(typeStr)
      ? (typeStr as LLMInferenceResult["type"])
      : "other";

    return { firstname, lastname, company, type };
  } catch (error) {
    // Silently fail - LLM inference is optional
    return null;
  }
}
