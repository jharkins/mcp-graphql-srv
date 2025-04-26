# MCP GraphQL Server (`mcp-graphql-srv`)

A Model Context Protocol (MCP) server implemented in TypeScript that acts as a proxy for a GraphQL endpoint. It uses Retrieval-Augmented Generation (RAG) on the target schema to provide enhanced schema introspection capabilities alongside standard query execution.

This server supports both modern Streamable HTTP and legacy HTTP+SSE MCP transport protocols.

## Features

Exposes a target GraphQL endpoint via MCP, providing:

*   An **internal vector store** containing embeddings of the target GraphQL schema for semantic search.
*   MCP Tools:
    *   **`search-schema`**: Performs semantic search over the embedded schema based on a natural language question.
    *   **`query-graphql`**: Executes a given GraphQL query or mutation against the target endpoint.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v18 or later recommended, requires ES2022 target for compilation)
*   [npm](https://www.npmjs.com/) (usually comes with Node.js)
*   `graphql` package (`npm install graphql`)
*   `@qdrant/js-client-rest` (`npm install @qdrant/js-client-rest`)
*   `openai` (`npm install openai`)
*   `@langchain/textsplitters` (`npm install @langchain/textsplitters`)
*   `p-limit` (`npm install p-limit`)
*   [Docker](https://www.docker.com/) (Optional, for running in a container)
*   A target GraphQL endpoint to proxy.
*   Access to Qdrant (via `QDRANT_URL`) and OpenAI (via `OPENAI_API_KEY`) for the RAG features.

## Setup

1.  **Clone the repository (if you haven't already):**
    ```bash
    # git clone <your-repo-url>
    # cd mcp-graphql-srv
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```
    *(This should install all necessary packages listed in `package.json`, including those mentioned in Prerequisites)*

## Configuration (Environment Variables)

This server is configured via environment variables:

*   `PORT`: Port the MCP server will listen on (Default: `3000`).
*   `ENDPOINT`: **Required.** The URL of the target GraphQL endpoint to proxy (e.g., `http://localhost:4000/graphql`). Used for queries and initial RAG schema loading if `SCHEMA` is not set.
*   `HEADERS`: Optional. A JSON string of headers to include when communicating with the target GraphQL endpoint (e.g., `'{"Authorization": "Bearer your_token"}'`). (Default: `{}`). **Note:** Invalid JSON will cause the server to fail on startup.
*   `ALLOW_MUTATIONS`: Optional. Set to `"true"` to allow GraphQL mutations. (Default: `"false"`).
*   `SCHEMA`: Optional. Path to a local GraphQL schema file (`.graphql` or `.gql`). If provided, this schema is used for RAG loading instead of introspecting the `ENDPOINT`.
*   `MCP_API_KEY`: Optional. If set, this MCP server requires an `X-API-Key` header matching this value on incoming MCP requests (`/mcp`, `/messages`).
    *   You can generate a suitable key using:
        ```bash
        npm run generate-api-key
        ```
*   `NAME`: Optional. Name for the MCP server instance. (Default: `mcp-graphql-srv`).
*   `QDRANT_URL`: **Required for RAG.** URL of your Qdrant instance.
*   `QDRANT_COLLECTION`: Optional. Name of the Qdrant collection to use. (Default: `graphql-schema`).
*   `OPENAI_API_KEY`: **Required for RAG.** Your OpenAI API key for embeddings.
*   `EMBED_MODEL`: Optional. OpenAI embedding model to use. (Default: `text-embedding-3-small`).

## Running Locally

1.  **Build the TypeScript code:**
    ```bash
    npm run build
    ```

2.  **Run the server with required environment variables:**
    Provide at least `ENDPOINT`, `QDRANT_URL`, and `OPENAI_API_KEY`.

    *   **Using `node` (after building):**
        ```bash
        export ENDPOINT="<your_graphql_endpoint_url>"
        export HEADERS='{"Authorization":"Bearer <your_token>"}' # Optional
        export MCP_API_KEY="<your_secret_key>"            # Optional
        export QDRANT_URL="<your_qdrant_url>"
        export OPENAI_API_KEY="<your_openai_key>"

        node dist/server.js
        ```
    *(Using `export` is common, adjust for your shell if needed. Use single quotes around JSON for `HEADERS`.)*

On startup, the server will load/introspect the schema and populate the Qdrant vector store before listening. The server supports graceful shutdown via `SIGTERM`.

## Running with Docker (Optional)

A `Dockerfile` is provided.

1.  **Build the Docker image:**
    ```bash
    docker build -t mcp-graphql-srv .
    ```

2.  **Run the container, passing environment variables:**
    ```bash
    docker run -d \
      -p 3000:3000 \
      -e PORT=3000 \
      -e ENDPOINT="<your_graphql_endpoint_url>" \
      -e HEADERS='{"Authorization":"Bearer <your_token>"}' \
      -e ALLOW_MUTATIONS="false" \
      -e MCP_API_KEY="<your_secret_key>" \
      -e QDRANT_URL="<your_qdrant_url>" \
      -e OPENAI_API_KEY="<your_openai_key>" \
      --name my-mcp-graphql-server \
      mcp-graphql-srv
    ```

The container will also perform the RAG initialization on startup and supports graceful shutdown.

## Testing with the Client

A simple test client script (`src/client.ts`) demonstrates interaction.

1.  Ensure the server is running and configured.
2.  Run the client, optionally providing the server URL:
    ```bash
    # Specify the server URL if not using the default (http://localhost:3000/sse)
    export MCP_SERVER_URL="<your_server_sse_endpoint_url>"

    # Run via ts-node
    npx ts-node src/client.ts

    # Or run the compiled version
    # npx tsc src/client.ts && node dist/client.js
    ```

The client will connect to the specified (or default) server URL, list tools, and call them. Note:
*   The **`search-schema`** tool now expects a natural language question (e.g., `{ question: "What fields are on the User type?" }`) and performs semantic search.
*   The sample client code may need adjustments to reflect this new input format for **`search-schema`**.
*   The client does not currently send `X-API-Key` if `MCP_API_KEY` is configured on the server.

## Tool Details

### `search-schema`

Performs semantic search over the embedded GraphQL schema based on a natural language question.

*   **Input Arguments:**
    *   `question` (string, required): Your question about the GraphQL schema (e.g., 'What fields are on the User type?', 'How to query for organizations?').
    *   `k` (number, optional): Number of relevant schema chunks to retrieve (Default: 5).
*   **Output:** Text content containing the relevant schema chunks found, separated by `\n\n---\n\n`.

### `query-graphql`

Executes a query or mutation against the target GraphQL endpoint.

*   **Input Arguments:**
    *   `query` (string, required): The GraphQL query or mutation string.
    *   `variables` (string, optional): A JSON string containing variables for the query/mutation.
*   **Output:** Text content containing the JSON response from the GraphQL endpoint.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 