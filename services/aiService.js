import dotenv from "dotenv";
import Groq from "groq-sdk";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// Fix for ES Modules __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const myCache = new NodeCache({ stdTTL: 60 * 60 * 24 });

// PATH SAFETY: Ensure file exists before reading
const productsFilePath = path.join(process.cwd(), "data", "products.json");
let productsData = [];
try {
  if (fs.existsSync(productsFilePath)) {
    productsData = JSON.parse(fs.readFileSync(productsFilePath, "utf-8"));
  } else {
    console.error("CRITICAL: data/products.json not found!");
  }
} catch (err) {
  console.error("Error reading products.json:", err);
}

function searchLocalProducts(keyword) {
  const words = keyword.toLowerCase().trim().split(/\s+/);
  const searchTerms = words.map((word) =>
    word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word,
  );

  const results = productsData.filter((p) => {
    const productText =
      `${p.name} ${p.category} ${p.tags?.join(" ") || ""}`.toLowerCase();
    return searchTerms.some((term) => productText.includes(term));
  });

  if (results.length > 0) {
    // Return max 5 items to keep token usage low
    return results.slice(0, 5).map((p) => ({
      name: p.name,
      price: `${p.currency} ${p.price}`,
      rating: p.rating,
      summary: p.review_summary?.[0] || "Great product!",
    }));
  }

  const categories = [...new Set(productsData.map((p) => p.category))];
  return {
    error: "no_direct_match",
    suggestedCategories: categories.slice(0, 5),
  };
}

export async function generate(userMessage, threadId) {
  const systemPrompt = {
    role: "system",
    content: `You are SG-AI, an expert retail assistant.
    - To search: Reply ONLY with "NEED_PRODUCT: <keyword>".
    - To respond to results: Use the data to sell. If no match, suggest the categories provided.
    - Always stay in character. Never mention "SYSTEM_NOTIFICATION".
    - Keep responses concise and formatted for readability.`,
  };

  let chatHistory = myCache.get(threadId) || [systemPrompt];
  chatHistory.push({ role: "user", content: userMessage });

  // Sliding window: System + last 5 turns
  if (chatHistory.length > 7) {
    chatHistory = [chatHistory[0], ...chatHistory.slice(-6)];
  }

  let currentTurnMessages = [...chatHistory];
  let loopCount = 0;

  try {
    while (loopCount < 3) {
      const completions = await groq.chat.completions.create({
        temperature: 0.1,
        model: "llama-3.3-70b-versatile",
        messages: currentTurnMessages,
      });

      const assistantContent = completions.choices[0]?.message?.content || "";

      if (!assistantContent.trim()) {
        loopCount++;
        continue;
      }

      if (!assistantContent.startsWith("NEED_PRODUCT:")) {
        // SUCCESS: Save final message and return
        chatHistory.push({ role: "assistant", content: assistantContent });
        myCache.set(threadId, chatHistory);
        return assistantContent;
      }

      // TOOL CALL
      const rawQuery = assistantContent.replace("NEED_PRODUCT:", "").trim();
      const toolResult = searchLocalProducts(rawQuery);

      // Update memory for the next loop iteration
      currentTurnMessages.push({
        role: "assistant",
        content: assistantContent,
      });
      currentTurnMessages.push({
        role: "system", // Using system role here makes AI follow the tool data more strictly
        content: `STORE_RESULT for "${rawQuery}": ${JSON.stringify(toolResult)}`,
      });

      loopCount++;
    }

    return "I found some great categories you might like! Check out our storefront for the latest arrivals.";
  } catch (error) {
    console.error("Groq Deployment Error:", error);
    // Graceful fallback so the frontend doesn't break
    return "I'm having trouble accessing the store right now. Please try again in a moment!";
  }
}
