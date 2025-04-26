import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAI } from "openai";
import pLimit from "p-limit";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL! });
const openai = new OpenAI();

const COL = process.env.QDRANT_COLLECTION ?? "graphql-schema";

/* ---------- 3-A  (re)load schema into the vector DB -------------------- */
export async function refreshSchema(schemaSDL: string) {
  // 1. Use RecursiveCharacterTextSplitter with custom separators
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 80,
    // Prioritize splitting on major definition boundaries
    separators: [
      "\n\ntype ", "\n\ninterface ", "\n\nenum ", "\n\ninput ",
      "\n\nscalar ", "\n\ndirective ", "\n\nunion ",
      "\n\n", "\n", " ", ""
    ],
    keepSeparator: true // Keep the separator prefix for context
  });
  const docs = await splitter.splitText(schemaSDL);
  console.log(`[RAG] Split schema into ${docs.length} documents.`);

  if (docs.length === 0) {
      console.error("[RAG] Error: No documents generated after splitting schema.");
      return;
  }

  // 2. Embed documents
  console.log(`[RAG] Starting embedding process for ${docs.length} documents...`);
  const limit = pLimit(3);
  let embeddedCount = 0;
  const totalDocs = docs.length;

  const vectors = await Promise.all(
    docs.map((docContent: string) => // Added type for docContent
      limit(async () => {
        try {
            const r = await openai.embeddings.create({
              model: process.env.EMBED_MODEL ?? "text-embedding-3-small",
              input: docContent
            });
            embeddedCount++;
            console.log(`[RAG] Embedded ${embeddedCount}/${totalDocs} documents...`);
            return { chunk: docContent, vec: r.data[0].embedding };
        } catch(embedError) {
            console.error(`[RAG] Error embedding chunk ${embeddedCount + 1}/${totalDocs}:`, embedError);
            return null;
        }
      })
    )
  );

  // Filter out any chunks that failed to embed
  const validVectors = vectors.filter(v => v !== null) as { chunk: string, vec: number[] }[];
  console.log(`[RAG] Embedding process completed. Successfully embedded ${validVectors.length} documents.`);

  // Check if vectors were generated
  if (validVectors.length === 0 || !validVectors[0]?.vec) {
      console.error("Error: No vectors generated from schema chunks.");
      return; // Or throw an error
  }

  try {
    // 3. Recreate collection
    console.log(`[RAG] Recreating Qdrant collection '${COL}'...`);
    await qdrant.recreateCollection(COL, {
      vectors: { size: validVectors[0].vec.length, distance: "Cosine" }
    });

    // 4. Upsert points
    console.log(`[RAG] Upserting ${validVectors.length} points into collection '${COL}'...`);
    await qdrant.upsert(COL, {
      points: validVectors.map((v: { chunk: string, vec: number[] }, i: number) => ({ // Added types for v and i
        id: i,
        vector: v.vec,
        payload: { text: v.chunk }
      }))
    });
    console.log(`[RAG] Schema refresh complete for collection '${COL}'.`);

  } catch (qdrantError) {
      console.error("[RAG] Error interacting with Qdrant:", qdrantError);
  }
}

/* ---------- 3-B  semantic retrieval ----------------------------------- */
export async function semanticSearch(question: string, k = 5) {
  const ve = await openai.embeddings.create({
    model: process.env.EMBED_MODEL ?? "text-embedding-3-small",
    input: question
  });
  const hits = await qdrant.search(COL, {
    vector: ve.data[0].embedding,
    limit: k
  });
  // Safely map results, providing default for missing text
  return hits.map(h => h.payload?.text as string ?? '');
}
