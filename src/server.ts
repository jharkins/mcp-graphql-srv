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
		.transform((val) => {
			try {
				return JSON.parse(val);
			} catch (e) {
				throw new Error("HEADERS must be a valid JSON string");
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
 * 1.  Build the MCP server instance
 * ------------------------------------------------------------------------- */
async function buildMcpServer(): Promise<McpServer> { // Changed to async
  console.log("[Server] Building new McpServer instance for a connection");
  const version = await getVersion(); // Await the version
  const server = new McpServer({
    name: env.NAME,
    version: version,
    description: `GraphQL MCP server for ${env.ENDPOINT}`,
  });

  // ── Resource: graphql-schema ─────────────────────────────────────────────
  server.resource("graphql-schema", new URL(env.ENDPOINT).href, async (uri) => {
    console.log(`[Server] Handling resource request: graphql-schema for uri='${uri}'`);
    try {
      let schema: string;
      if (env.SCHEMA) {
        console.log(`[Server] Introspecting local schema file: ${env.SCHEMA}`);
        schema = await introspectLocalSchema(env.SCHEMA);
      } else {
        console.log(`[Server] Introspecting remote endpoint: ${env.ENDPOINT}`);
        schema = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
      }

      return {
        contents: [
          {
            uri: uri.href,
            text: schema,
          },
        ],
      };
    } catch (error: any) {
      console.error("[Server] Error getting GraphQL schema resource:", error);
      // Re-throw to let the MCP SDK handle resource errors
      throw new Error(`Failed to get GraphQL schema: ${error.message}`);
    }
  });

  // ── Tool: introspect-schema ──────────────────────────────────────────────
  server.tool(
    "introspect-schema",
    "Introspect the GraphQL schema. Use this tool before querying if you don't have the schema available as a resource.",
    {},
    async () => {
      console.log(`[Server] Handling tool call: introspect-schema`);
      try {
        let schema: string;
        if (env.SCHEMA) {
          console.log(`[Server] Introspecting local schema file: ${env.SCHEMA}`);
          schema = await introspectLocalSchema(env.SCHEMA);
        } else {
          console.log(`[Server] Introspecting remote endpoint: ${env.ENDPOINT}`);
          schema = await introspectEndpoint(env.ENDPOINT, env.HEADERS);
        }

        return {
          content: [
            {
              type: "text",
              text: schema,
            },
          ],
        };
      } catch (error: any) {
        console.error("[Server] Error in introspect-schema tool:", error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Failed to introspect schema: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // ── Tool: query-graphql ──────────────────────────────────────────────────
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

        const responseText = await response.text(); // Read text first for better error reporting

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

        // Attempt to parse JSON, handle potential errors
        let data;
        try {
          data = JSON.parse(responseText);
        } catch (error: any) {
            console.error("[Server] Failed to parse GraphQL JSON response:", error, responseText);
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: `Failed to parse GraphQL JSON response: ${error.message}\nResponse Body:\n${responseText}`,
                    },
                ],
            };
        }

        // Check for GraphQL-level errors in the response
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
      } catch (error: any) {
        console.error("[Server] Failed to execute GraphQL query:", error);
        // Use isError for fetch/network level errors
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: `Failed to execute GraphQL query: ${error.message}`,
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
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => { streamableTransports[id] = transport; console.log(`[Server] Streamable HTTP session initialized: ${id}`); }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
          console.log(`[Server] Streamable HTTP transport closed for session: ${transport.sessionId}`);
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
const serverInstance = app.listen(PORT, () => {
  console.log(`MCP GraphQL server '${env.NAME}' targeting endpoint ${env.ENDPOINT} listening on http://localhost:${PORT}`);
  console.log(`Allow mutations: ${env.ALLOW_MUTATIONS}`);
  if (env.MCP_API_KEY) {
      console.log(`API Key Authentication: ENABLED (expecting X-API-Key header)`);
  } else {
      console.log("API Key Authentication: DISABLED");
  }
  if (env.SCHEMA) {
    console.log(`Using local schema: ${env.SCHEMA}`);
  }
  if (Object.keys(env.HEADERS).length > 0) {
    console.log(`Using custom headers for GraphQL endpoint: ${JSON.stringify(env.HEADERS)}`); // Clarified header purpose
  }
});

serverInstance.on('error', (error) => {
  console.error("Server listening error:", error);
  process.exit(1); // Exit if listening fails critically
});
