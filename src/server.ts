/* ---------------------------------------------------------------------------
 * server.ts ― MCP GraphQL Server with Streamable HTTP + legacy HTTP+SSE
 * ------------------------------------------------------------------------- */

import express, { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parse } from "graphql/language";
import { introspectEndpoint, introspectLocalSchema } from "./introspection.js";
import { refreshSchema, semanticSearch } from "./rag.js";
import fs from "node:fs/promises";
import path from "node:path";

/* ---------------------------------------------------------------------------
 * Environment Variable Parsing
 * ------------------------------------------------------------------------- */

const EnvSchema = z.object({
	NAME: z.string().default("mcp-graphql-srv"),
	ENDPOINT: z.string().url().default("http://localhost:4000/graphql"),
	ALLOW_MUTATIONS: z
		.enum(["true", "false"])
		.transform((value) => value === "true")
		.default("false"),
	HEADERS: z
		.string()
		.default("{}")
		.transform((val, ctx) => {
			try {
				return JSON.parse(val);
			} catch (e: any) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `HEADERS must be a valid JSON string: ${e.message}`,
				});
				return z.NEVER;
			}
		}),
	SCHEMA: z.string().optional(),
	MCP_API_KEY: z.string().optional().describe("Optional API key required in X-API-Key header for server access"),
});

let env: z.infer<typeof EnvSchema>;
try {
  env = EnvSchema.parse(process.env);
} catch (error) {
  console.error("Error parsing environment variables:", error);
  process.exit(1);
}

/* ---------------------------------------------------------------------------
 * Helper Functions
 * ------------------------------------------------------------------------- */

// Helper function to get the version from package.json
async function getVersion(): Promise<string> {
  try {
    const packageJsonPath = path.resolve(process.cwd(), "package.json");
    const packageJsonContent = await fs.readFile(packageJsonPath, "utf8");
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version || "0.0.0";
  } catch (error) {
    console.warn("Could not read version from package.json:", error);
    return "0.0.0"; // Default version if reading fails
  }
}

/* ---------------------------------------------------------------------------
 * Authentication Middleware
 * ------------------------------------------------------------------------- */

function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
    // Skip auth if MCP_API_KEY is not configured
    if (!env.MCP_API_KEY) {
        return next();
    }

    const providedKey = req.headers['x-api-key'];

    if (!providedKey) {
        console.warn("[Server] Authentication failed: Missing X-API-Key header");
        return res.status(401).send("Unauthorized: Missing X-API-Key header");
    }

    if (providedKey !== env.MCP_API_KEY) {
        console.warn("[Server] Authentication failed: Invalid X-API-Key");
        return res.status(403).send("Forbidden: Invalid API Key");
    }

    // API key is valid
    console.log("[Server] API Key authentication successful.");
    next();
}

/* ---------------------------------------------------------------------------
 * RAG Initialization (Run Once on Startup)
 * ------------------------------------------------------------------------- */
async function initializeVectorStore() {
    console.log("[RAG] Initializing vector store...");
    let schemaSDL: string;
    try {
        if (env.SCHEMA) {
            console.log(`[RAG] Loading schema from local file: ${env.SCHEMA}`);
            schemaSDL = await introspectLocalSchema(env.SCHEMA);
        } else {
            console.log(`[RAG] Introspecting schema from remote endpoint: ${env.ENDPOINT}`);
            schemaSDL = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
        }
        console.log(`[RAG] Schema loaded successfully, refreshing vector store...`);
        await refreshSchema(schemaSDL);
        console.log("[RAG] Vector store initialization complete.");
    } catch (error: any) {
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        console.error("[RAG] FATAL: Failed to initialize vector store:", error.message);
        console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        // Depending on criticality, you might want to exit
        // process.exit(1);
    }
}

/* ---------------------------------------------------------------------------
 * 1.  Build the MCP server instance
 * ------------------------------------------------------------------------- */
async function buildMcpServer(): Promise<McpServer> {
  console.log("[Server] Building new McpServer instance for a connection");
  const version = await getVersion();
  const server = new McpServer({
    name: env.NAME,
    version: version,
    description: `GraphQL MCP server for ${env.ENDPOINT}`,
  });

  // Remove the on-demand graphql-schema resource, rely on RAG store
  // server.resource("graphql-schema", ...);

  // ── Tool: search-schema (Formerly introspect-schema, uses RAG) ──────────
  server.tool(
    "search-schema",
    "Retrieve relevant parts of the GraphQL schema using semantic search. Ask specific questions about types, fields, queries, or mutations.",
    {
      question: z.string().describe("Your question about the GraphQL schema (e.g., 'What fields are on the User type?', 'How to query for organizations?')"),
      k: z.number().optional().default(5).describe("Number of relevant schema chunks to retrieve (default: 5)"),
    },
    async ({ question, k }) => {
      console.log(`[Server] Handling tool call: search-schema with query: "${question}" (k=${k})`);
      try {
        const searchResults = await semanticSearch(question, k);
        if (searchResults.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No relevant schema information found for your question.",
              },
            ],
          };
        }
        // Combine results into a single text block
        const combinedText = searchResults.join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text",
              text: combinedText,
            },
          ],
        };
      } catch (error: any) {
        console.error("[Server] Error in search-schema tool (RAG search):", error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to search schema: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // ── Tool: query-graphql (Unchanged) ──────────────────────────────────────
  server.tool(
    "query-graphql",
    "Query a GraphQL endpoint with the given query and optional variables.",
    {
      query: z.string().describe("The GraphQL query or mutation string."),
      variables: z.string().optional().describe("JSON string containing query variables."),
    },
    async ({ query, variables }) => {
      console.log(`[Server] Handling tool call: query-graphql for endpoint: ${env.ENDPOINT}`);
      // Parse variables if provided
      let parsedVariables: Record<string, any> | undefined;
      if (variables) {
        try {
          parsedVariables = JSON.parse(variables);
        } catch (error: any) {
          console.error("[Server] Error parsing variables JSON:", error);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Invalid variables: Must be a valid JSON string. Error: ${error.message}`,
              },
            ],
          };
        }
      }

      // Validate query and check for mutations if disallowed
      try {
        const parsedQuery = parse(query);
        const isMutation = parsedQuery.definitions.some(
          (def) =>
            def.kind === "OperationDefinition" && def.operation === "mutation",
        );

        if (isMutation && !env.ALLOW_MUTATIONS) {
          console.warn("[Server] Mutation detected but not allowed by configuration.");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Mutations are not allowed. Set ALLOW_MUTATIONS=true to enable them.",
              },
            ],
          };
        }
      } catch (error: any) {
        console.error("[Server] Invalid GraphQL query:", error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Invalid GraphQL query: ${error.message}`,
            },
          ],
        };
      }

      // Execute the GraphQL query
      try {
        console.log(`[Server] Executing GraphQL query against ${env.ENDPOINT}`);
        const response = await fetch(env.ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...env.HEADERS,
          },
          body: JSON.stringify({
            query,
            variables: parsedVariables, // Use parsed variables
          }),
        });

        const responseText = await response.text();

        if (!response.ok) {
          console.error(`[Server] GraphQL request failed: ${response.status} ${response.statusText}`, responseText);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `GraphQL request failed: ${response.status} ${response.statusText}\n${responseText}`,
              },
            ],
          };
        }

        // Harden JSON parsing
        let data;
        try {
          data = JSON.parse(responseText);
        } catch (parseError: any) {
          console.error("[Server] Failed to parse GraphQL JSON response:", parseError, responseText);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to parse GraphQL JSON response: ${parseError.message}\nResponse Body Hint:\n${responseText.substring(0, 200)}...`,
              },
            ],
          };
        }

        // Check for GraphQL-level errors in the now successfully parsed response
        if (data.errors && data.errors.length > 0) {
          console.warn("[Server] GraphQL response contained errors:", data.errors);
          return {
            // isError: true, // Consider if GraphQL errors should halt the agent
            content: [
              {
                type: "text",
                text: `GraphQL query executed, but the response contains errors: ${JSON.stringify(data, null, 2)}`,
              },
            ],
          };
        }

        // Success
        console.log("[Server] GraphQL query successful.");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (fetchError: any) {
        console.error("[Server] Failed to execute GraphQL query (network/fetch issue?):", fetchError);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to execute GraphQL query: ${fetchError.message}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

/* ---------------------------------------------------------------------------
 * 2.  Transport registries – keep track of active sessions
 * ------------------------------------------------------------------------- */
const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};
const sseTransports: Record<string, SSEServerTransport> = {};

/* ---------------------------------------------------------------------------
 * 3.  Express wiring
 * ------------------------------------------------------------------------- */
const app = express();
app.use(express.json());

// Apply API key authentication middleware to MCP endpoints
app.use("/mcp", authenticateApiKey);
app.use("/messages", authenticateApiKey); // Also protect the SSE message endpoint

/* ---------- 3-A: modern Streamable HTTP endpoint -------------------------- */
app.all("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && streamableTransports[sessionId]) {
    console.log(`[Server] Reusing Streamable HTTP transport for session: ${sessionId}`);
    transport = streamableTransports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    console.log("[Server] Creating new Streamable HTTP transport");
    let sessionTimeoutHandle: NodeJS.Timeout | null = null;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
          streamableTransports[id] = transport;
          console.log(`[Server] Streamable HTTP session initialized: ${id}`);

          const timeoutMs = 1000 * 60 * 60; // 1 hour
          console.log(`[Server] Setting idle timeout for session ${id}: ${timeoutMs / 1000 / 60} minutes`);
          sessionTimeoutHandle = setTimeout(() => {
              console.warn(`[Server] Cleaning up idle Streamable HTTP session: ${id}`);
              delete streamableTransports[id];
              try {
                  transport.close();
              } catch (e) { /* Ignore errors if already closed */ }
          }, timeoutMs);
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
          console.log(`[Server] Streamable HTTP transport closed for session: ${transport.sessionId}`);
          if (sessionTimeoutHandle) {
              clearTimeout(sessionTimeoutHandle);
              console.log(`[Server] Cleared idle timeout for session ${transport.sessionId}`);
          }
          delete streamableTransports[transport.sessionId];
      }
    };

    const server = await buildMcpServer();
    await server.connect(transport);
  } else {
    console.warn("[Server] Invalid Streamable HTTP handshake request");
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: invalid MCP handshake" },
      id: null
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

/* ---------- 3-B: legacy SSE compatibility -------------------------------- */
app.get("/sse", async (req: Request, res: Response) => {
  console.log("[Server] Received request for SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  console.log(`[Server] SSE transport created with sessionId: ${transport.sessionId}`);

  res.on("close", () => {
    console.log(`[Server] SSE connection closed for sessionId: ${transport.sessionId}`);
    delete sseTransports[transport.sessionId];
  });

  const server = await buildMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports[sessionId];
  console.log(`[Server] Received POST /messages for SSE sessionId: ${sessionId}`);

  if (!transport) {
    console.warn(`[Server] Unknown or expired SSE sessionId: ${sessionId}`);
    res.status(400).send("Unknown or expired sessionId");
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

/* ---------------------------------------------------------------------------
 * 4.  Startup
 * ------------------------------------------------------------------------- */
const PORT = Number(process.env.PORT ?? 3000);
let serverInstance: ReturnType<typeof app.listen> | null = null;

(async () => {
    await initializeVectorStore();

    serverInstance = app.listen(PORT, () => {
      console.log(`MCP GraphQL server '${env.NAME}' targeting endpoint ${env.ENDPOINT} listening on http://localhost:${PORT}`);
      console.log(`Allow mutations: ${env.ALLOW_MUTATIONS}`);
      if (env.MCP_API_KEY) {
          console.log(`API Key Authentication: ENABLED (expecting X-API-Key header)`);
      } else {
          console.log("API Key Authentication: DISABLED");
      }
      if (env.SCHEMA) {
        console.log(`RAG Schema Source: Local file (${env.SCHEMA})`);
      } else {
        console.log(`RAG Schema Source: Remote endpoint (${env.ENDPOINT})`);
      }
      if (Object.keys(env.HEADERS).length > 0) {
        console.log(`Using custom headers for GraphQL endpoint: ${JSON.stringify(env.HEADERS)}`);
      }
    });

    serverInstance.on('error', (error) => {
      console.error("Server listening error:", error);
      process.exit(1);
    });

})();

// Graceful Shutdown Handler
process.on("SIGTERM", () => {
    console.log("[Server] SIGTERM signal received: closing HTTP server");
    if (serverInstance) {
        serverInstance.close(() => {
            console.log("[Server] HTTP server closed");
            process.exit(0);
        });
    } else {
        process.exit(1);
    }
});
