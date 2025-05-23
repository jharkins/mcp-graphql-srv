import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// Unused import: StreamableHTTPClientTransport
// import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"; 
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

// Read server URL from environment variable, with a default for local testing
const serverUrlString = process.env.MCP_SERVER_URL ?? "http://localhost:3000/sse";
let baseUrl: URL;
try {
    baseUrl = new URL(serverUrlString);
} catch (e) {
    console.error(`Invalid MCP_SERVER_URL: ${serverUrlString}. Please provide a valid URL.`);
    process.exit(1);
}

console.log(`[Client] Target MCP Server URL: ${baseUrl.href}`);

let client: Client|undefined = undefined

// Helper to safely extract text content from tool result
function getResultText(result: any): string {
  if (result?.content?.[0]?.type === 'text') {
    return result.content[0].text;
  }
  // Fallback for unexpected structure or non-text content
  return JSON.stringify(result?.content ?? result, null, 2);
}

async function main() {
  client = new Client({
    name: 'graphql-test-client',
    version: '1.0.0'
  });
  const sseTransport = new SSEClientTransport(baseUrl);

  try {
    await client.connect(sseTransport);
    console.log("Connected using SSE transport to", baseUrl.href);

    console.log("\n--- Listing Available Tools ---");
    const toolsResponse = await client.listTools();
    console.log("[Client] List Tools Response:", JSON.stringify(toolsResponse, null, 2));

    const toolsList = (toolsResponse as any)?.tools;
    if (!Array.isArray(toolsList)) {
        console.error("[Client] Error: Could not find tools array in listTools response.", toolsList);
        return;
    }

    const toolNames = toolsList.map((t: any) => t.name);
    if (!toolNames.includes("search-schema") || !toolNames.includes("query-graphql")) {
        console.error("[Client] Error: Expected tools (search-schema, query-graphql) not found. Available:", toolNames);
        return;
    }

    console.log("\n--- Testing GraphQL Tools ---");

    // 1. Test schema search (Formerly introspection)
    const schemaQuestion = "What queries are available in the schema?";
    const kResults = 3;
    console.log(`\n[Client] Calling search-schema with question: "${schemaQuestion}" (k=${kResults})...`);
    let result = await client.callTool({
        name: "search-schema",
        arguments: { question: schemaQuestion, k: kResults }
    });
    console.log("[Client] Semantic Schema Search Result (isError:", result.isError ?? false, "):\n", getResultText(result));

    // 2. Test simple query
    const simpleQuery = '{ __typename }';
    console.log(`\n[Client] Calling query-graphql with simple query: ${simpleQuery}`);
    result = await client.callTool({ name: "query-graphql", arguments: { query: simpleQuery } });
    console.log("[Client] Simple Query Result (isError:", result.isError ?? false, "):\n", getResultText(result));

    // 3. Test query with variables (ADJUST QUERY/VARIABLES BASED ON YOUR ENDPOINT)
    const queryWithVars = `query GetGreeting($name: String!) {
      greeting(name: $name)
    }`;
    const variablesForQuery = JSON.stringify({ name: "MCP User" });
    console.log(`\n[Client] Calling query-graphql with query and variables:`);
    console.log("  Query:", queryWithVars);
    console.log("  Variables:", variablesForQuery);
    result = await client.callTool({
        name: "query-graphql",
        arguments: { query: queryWithVars, variables: variablesForQuery }
    });
    console.log("[Client] Query with Variables Result (isError:", result.isError ?? false, "):\n", getResultText(result));

    // 4. Test invalid query syntax
    const invalidQuery = '{ missingClosingBrace';
    console.log(`\n[Client] Calling query-graphql with invalid query: ${invalidQuery}`);
    result = await client.callTool({ name: "query-graphql", arguments: { query: invalidQuery } });
    console.log("[Client] Invalid Query Result (isError:", result.isError ?? false, "):\n", getResultText(result));

    // 5. Test invalid variables JSON
    const invalidVariables = '{ "name": "MissingQuote }';
    console.log(`\n[Client] Calling query-graphql with invalid variables JSON: ${invalidVariables}`);
    result = await client.callTool({
        name: "query-graphql",
        arguments: { query: simpleQuery, variables: invalidVariables } // Use simple query here
    });
    console.log("[Client] Invalid Variables Result (isError:", result.isError ?? false, "):\n", getResultText(result));

    // 6. Test mutation when disallowed (assuming default ALLOW_MUTATIONS=false)
    const mutationQuery = 'mutation { addData(input: { value: "test" }) { id } }'; // Example mutation
    console.log(`\n[Client] Calling query-graphql with mutation (expecting error if disallowed): ${mutationQuery}`);
    result = await client.callTool({ name: "query-graphql", arguments: { query: mutationQuery } });
    console.log("[Client] Mutation Result (isError:", result.isError ?? false, "):\n", getResultText(result));
    // Add a check here if you want to assert the specific error message
    if (!result.isError && getResultText(result).includes("Mutations are not allowed")) {
        console.log("[Client] Received expected mutation disallowed error.");
    } else if (result.isError) {
         console.log("[Client] Received an error as expected (might be disallowed or other).");
    } else {
         console.warn("[Client] Warning: Mutation did not result in expected 'disallowed' error. Check ALLOW_MUTATIONS setting.");
    }

    console.log("\n--- Finished Testing GraphQL Tools ---");

  } catch (error) {
    console.error("\n[Client] Critical Client Error:", error);
  } finally {
    if (client) {
      console.log("\n[Client] Closing connection...");
      try {
        await client.close();
        console.log("[Client] Connection closed.");
      } catch (closeError) {
        console.error("[Client] Error during close:", closeError);
      }
    }
  }
}

main().catch(error => {
  console.error("Client error:", error);
  process.exit(1);
});

// NOTE: This client does not currently send the X-API-Key header.
// If the server is configured with MCP_API_KEY, tool calls will likely fail.
// Use StreamableHTTPClientTransport with custom headers for API key auth.