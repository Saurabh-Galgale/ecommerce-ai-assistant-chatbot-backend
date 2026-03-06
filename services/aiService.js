import dotenv from "dotenv";
import Groq from "groq-sdk";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
// Cache memory for 24 hours to keep threads alive
const myCache = new NodeCache({ stdTTL: 60 * 60 * 24 });

// Load Product Data
const productsFilePath = path.resolve("data", "products.json");
const productsData = JSON.parse(fs.readFileSync(productsFilePath, "utf-8"));

/**
 * SMART SEARCH LOGIC
 * Filters products but returns available categories if nothing matches
 * so the AI can pivot the conversation.
 */
function searchLocalProducts(keyword) {
  const words = keyword.toLowerCase().trim().split(/\s+/);

  // Stemming: remove 's' from end of words longer than 3 chars
  const searchTerms = words.map((word) =>
    word.endsWith("s") && word.length > 3 ? word.slice(0, -1) : word,
  );

  const results = productsData.filter((p) => {
    const productText =
      `${p.name} ${p.category} ${p.description} ${p.tags.join(" ")}`.toLowerCase();
    return searchTerms.some((term) => productText.includes(term));
  });

  if (results.length > 0) {
    return results;
  }

  // PIVOT DATA: If no match, give the AI the catalog context
  const categories = [...new Set(productsData.map((p) => p.category))];
  const sampleProducts = productsData.slice(0, 3).map((p) => p.name);

  return {
    error: "no_direct_match",
    suggestedCategories: categories,
    nearbyOptions: sampleProducts,
    message: `We don't have items matching '${keyword}' directly. Use the suggestedCategories to offer an alternative.`,
  };
}

export async function generate(userMessage, threadId) {
  const baseMessages = [
    {
      role: "system",
      content: `
You are the SG-AI Smart Assistant. You are an expert at e-commerce sales and general knowledge.

STRICT OPERATING RULES:
1. SEARCH TRIGGER: If the user wants to find, buy, or see products, respond ONLY with: NEED_PRODUCT: <keyword>.
2. PIVOTING: If a search returns "no_direct_match", DO NOT say "I don't have that." Instead, check the 'suggestedCategories' provided and say: "We don't carry [X] specifically, but we do have a great range of [Category A] and [Category B]. Would you like to see those?"
3. GENERAL CHAT: If the user asks general questions (e.g., "What is AI?"), answer normally using your own knowledge. Do not trigger NEED_PRODUCT.
4. SALES MODE: When you have product data, use the "review_summary" and "specs" to convince the user. Mention specific product names clearly.
5. MEMORY: You are talking to the same user in a thread. Stay helpful and concise.
      `.trim(),
    },
  ];

  // 1. Get history or start new
  let chatHistory = myCache.get(threadId) || [...baseMessages];

  // 2. Add User Input
  chatHistory.push({ role: "user", content: userMessage });

  // 3. OPTIMIZATION: Sliding Window (Free Tier Friendly)
  // Keeps system prompt + last 6 messages (Prevents token bloat)
  if (chatHistory.length > 7) {
    chatHistory = [chatHistory[0], ...chatHistory.slice(-6)];
  }

  // Temporary array for the current thought process (won't bloat the long-term cache)
  let currentTurnMessages = [...chatHistory];

  try {
    while (true) {
      const completions = await groq.chat.completions.create({
        temperature: 0.2, // Low temp for reliability, slight bump for "creative" pivoting
        model: "llama-3.3-70b-versatile",
        messages: currentTurnMessages,
      });

      const assistantMessage = completions.choices[0].message;
      const assistantContent = assistantMessage.content || "";

      // CASE A: AI wants to talk to user
      if (!assistantContent.startsWith("NEED_PRODUCT:")) {
        chatHistory.push(assistantMessage);
        myCache.set(threadId, chatHistory);
        return assistantContent;
      }

      // CASE B: AI needs to search the store
      currentTurnMessages.push(assistantMessage);
      const rawQuery = assistantContent.replace("NEED_PRODUCT:", "").trim();

      const toolResult = searchLocalProducts(rawQuery);

      // Inject search result as a "tool response" for the AI to read
      currentTurnMessages.push({
        role: "assistant", // Using assistant/user pattern for tool emulation if needed
        content: `STORE_RESULT: ${JSON.stringify(toolResult)}`,
      });

      // Loop continues, AI will now generate the final response based on STORE_RESULT
    }
  } catch (error) {
    console.error("Groq API Error:", error);
    return "I'm having a bit of trouble connecting to my database. Can you try asking that again?";
  }
}
