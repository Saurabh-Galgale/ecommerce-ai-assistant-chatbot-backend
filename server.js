import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { generate } from "./services/aiService.js";

const app = express();
const port = 8080;

app.use(cors());
app.use(express.json());

const getProducts = () => {
  const filePath = path.resolve("data", "products.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
};

app.get("/", (req, res) => {
  res.send("Server running");
});

app.get("/api/products", (req, res) => {
  try {
    const products = getProducts();
    const { category } = req.query;

    if (category) {
      const filtered = products.filter(
        (p) => p.category.toLowerCase() === category.toLowerCase(),
      );
      return res.json(filtered);
    }

    res.json(products);
  } catch {
    res.status(500).json({ error: "Failed to load products" });
  }
});

app.get("/api/products/:id", (req, res) => {
  try {
    const products = getProducts();
    const product = products.find((p) => p.id === req.params.id);

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(product);
  } catch {
    res.status(500).json({ error: "Failed to load product" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { userMessage, threadId } = req.body;

  if (!userMessage || !threadId) {
    return res.status(400).json({
      error: "userMessage and threadId are required",
    });
  }

  try {
    const result = await generate(userMessage, threadId);
    res.json({ message: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate AI response" });
  }
});

app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
});
