import dotenv from "dotenv";
import Groq from "groq-sdk";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
// Cache memory till 24 hours
const myCache = new NodeCache({ stdTTL: 60 * 60 * 24 });

const productsFilePath = path.resolve("data", "products.json");
const productsData = JSON.parse(fs.readFileSync(productsFilePath, "utf-8"));

function searchLocalProducts(keyword) {
  const lowerKeyword = keyword.toLowerCase();

  // Optimization: Instead of returning the full description/specs if not needed,
  // we could trim it here, but keeping it as is ensures the AI has context.
  const results = productsData.filter(
    (p) =>
      p.name.toLowerCase().includes(lowerKeyword) ||
      p.category.toLowerCase().includes(lowerKeyword) ||
      p.description.toLowerCase().includes(lowerKeyword) ||
      p.tags.some((tag) => tag.toLowerCase().includes(lowerKeyword)),
  );

  return results.length
    ? results
    : [{ message: "No matching products found in store." }];
}

export async function generate(userMessage, threadId) {
  const baseMessages = [
    {
      role: "system",
      content: `
You are a smart, friendly e-commerce shopping assistant, but you are also a highly knowledgeable general AI.

Rules:
1. STORE/PRODUCT QUERIES: If a user asks about finding products, recommendations, or features related to our store, respond ONLY with the exact string: NEED_PRODUCT: <search_keyword> (e.g., NEED_PRODUCT: shoes, NEED_PRODUCT: study). Do not add any other text.
2. GENERAL KNOWLEDGE/CASUAL CHAT: If the user asks a general question unrelated to shopping, DO NOT output NEED_PRODUCT. Answer directly, thoroughly, and politely using your own general knowledge.
3. HANDLING TOOL RESPONSES: Once you receive the local product data back as a tool response, act as a helpful sales assistant. Answer specifically using the review summaries and specs provided. If the store doesn't have it, gently suggest they ask about something else we might carry.
4. Never mention the NEED_PRODUCT system in your final replies.
      `.trim(),
    },
  ];

  // 1. Fetch clean history (No heavy JSON dumps from past turns)
  // CRITICAL FIX: Use [...baseMessages] to avoid mutating the original array
  let chatHistory = myCache.get(threadId) || [...baseMessages];

  // 2. Add the new user message to the clean history
  chatHistory.push({
    role: "user",
    content: userMessage,
  });

  // OPTIMIZATION 1: "Sliding Window" - Keep memory lightweight
  // If history gets too long (System prompt + last 6 messages), slice the old ones out.
  // 1 system + 6 context messages = 7 max length.
  if (chatHistory.length > 7) {
    chatHistory = [chatHistory[0], ...chatHistory.slice(-6)];
  }

  // OPTIMIZATION 2: "Ghost Tool Data" - Create a temporary array for this specific turn
  // This prevents the NEED_PRODUCT string and heavy JSON from getting saved to cache
  let currentTurnMessages = [...chatHistory];

  while (true) {
    const completions = await groq.chat.completions.create({
      temperature: 0, // 0 is best for tool calling reliability
      model: "llama-3.3-70b-versatile",
      messages: currentTurnMessages,
    });

    const assistantMessage = completions.choices[0].message;
    const assistantContent = assistantMessage.content || "";

    // If the AI didn't ask for a product, it's the final answer!
    if (!assistantContent.startsWith("NEED_PRODUCT:")) {
      // Save ONLY the final conversational answer to the clean history cache
      chatHistory.push(assistantMessage);
      myCache.set(threadId, chatHistory);
      return assistantContent;
    }

    // AI requested a product search.
    // Push the NEED_PRODUCT message ONLY to the temporary turn array
    currentTurnMessages.push(assistantMessage);

    const rawQuery = assistantContent.replace("NEED_PRODUCT:", "").trim();
    if (!rawQuery) {
      console.error("No query found after NEED_PRODUCT:");
      break;
    }

    // Execute local database search
    const toolResult = searchLocalProducts(rawQuery);
    const fallbackToolCallId = `localDbSearch_${Date.now()}`;

    // Push the heavy JSON array ONLY to the temporary turn array
    currentTurnMessages.push({
      role: "tool",
      tool_call_id: fallbackToolCallId,
      name: "localDbSearch",
      content: JSON.stringify(toolResult),
    });

    // The while loop will now run one more time with the injected JSON,
    // generate the final text, hit the `if` statement above, save the clean history, and return!
  }
}
