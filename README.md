# MCP GraphQL Server (`mcp-graphql-srv`)

A Model Context Protocol (MCP) server implemented in TypeScript that acts as a proxy for a GraphQL endpoint, providing tools to introspect the schema and execute queries/mutations.

This server supports both modern Streamable HTTP and legacy HTTP+SSE MCP transport protocols.

## Features

Exposes a target GraphQL endpoint via MCP, providing:

*   An MCP Resource (`graphql-schema`) containing the GraphQL schema (obtained via introspection or a local file).
*   MCP Tools:
    *   **`introspect-schema`**: Fetches and returns the GraphQL schema SDL.
    *   **`query-graphql`**: Executes a given GraphQL query or mutation against the target endpoint.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v18 or later recommended, requires ES2022 target for compilation)
*   [npm](https://www.npmjs.com/) (usually comes with Node.js)
*   `graphql` package (install via `npm install graphql`)
*   [Docker](https://www.docker.com/) (Optional, for running in a container)
*   A target GraphQL endpoint to proxy.

## Setup

1.  **Clone the repository (if you haven't already):**
    ```bash
    # git clone <your-repo-url>
    # cd mcp-graphql-srv
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # Ensure graphql is installed
    npm install graphql
    ```

## Configuration (Environment Variables)

This server is configured via environment variables:

*   `PORT`: Port the MCP server will listen on (Default: `3000`).
*   `ENDPOINT`: **Required.** The URL of the target GraphQL endpoint to proxy (e.g., `http://localhost:4000/graphql`).
*   `HEADERS`: Optional. A JSON string of headers to include when communicating with the target GraphQL endpoint (e.g., `'{"Authorization": "Bearer your_token"}'`). (Default: `{}`).
*   `ALLOW_MUTATIONS`: Optional. Set to `"true"` to allow GraphQL mutations. (Default: `"false"`).
*   `SCHEMA`: Optional. Path to a local GraphQL schema file (`.graphql` or `.gql`). If provided, this schema is used instead of introspecting the `ENDPOINT`.
*   `MCP_API_KEY`: Optional. If set, this MCP server requires an `X-API-Key` header matching this value on incoming MCP requests (`/mcp`, `/messages`).
    *   You can generate a suitable key using:
        ```bash
        npm run generate-api-key
        ```
*   `NAME`: Optional. Name for the MCP server instance. (Default: `mcp-graphql-srv`).

## Running Locally

1.  **Build the TypeScript code:**
    ```bash
    npm run build
    ```
    This compiles the TypeScript source in `src/` to JavaScript in `dist/`.

2.  **Run the server with required environment variables:**
    Provide at least the `ENDPOINT`.

    *   **Using `ts-node` (development):**
        ```bash
        ENDPOINT="<your_graphql_endpoint_url>" \
        HEADERS='{"Authorization":"Bearer <your_token>"}' \
        MCP_API_KEY="<your_secret_key>" \
        npx ts-node src/server.ts
        ```
    *   **Using `node` (after building):**
        ```bash
        ENDPOINT="<your_graphql_endpoint_url>" \
        HEADERS='{"Authorization":"Bearer <your_token>"}' \
        MCP_API_KEY="<your_secret_key>" \
        node dist/server.js
        ```
    *(Adjust `HEADERS`, `MCP_API_KEY`, etc. as needed. Use single quotes around JSON for `HEADERS` in shell)*

The server will start, typically listening on port 3000. Output will show the configuration:
```
MCP GraphQL server 'mcp-graphql-srv' targeting endpoint <your_graphql_endpoint_url> listening on http://localhost:3000
Allow mutations: false
API Key Authentication: ENABLED (expecting X-API-Key header)
Using custom headers for GraphQL endpoint: {"Authorization":"Bearer <your_token>"}
```

## Running with Docker (Optional)

A `Dockerfile` is provided for building and running the server in a container.

1.  **Build the Docker image:**
    ```bash
    docker build -t mcp-graphql-srv .
    ```

2.  **Run the container, passing environment variables:**
    Use the `-e` flag to set environment variables.
    ```bash
    docker run -d \
      -p 3000:3000 \
      -e PORT=3000 \
      -e ENDPOINT="<your_graphql_endpoint_url>" \
      -e HEADERS='{"Authorization":"Bearer <your_token>"}' \
      -e ALLOW_MUTATIONS="false" \
      -e MCP_API_KEY="<your_secret_key>" \
      --name my-mcp-graphql-server \
      mcp-graphql-srv
    ```
    *   `-d`: Run in detached mode.
    *   `-p 3000:3000`: Map host port to container port.
    *   `-e VARIABLE="value"`: Set environment variables.
    *   `--name ...`: Assign a container name.

The server will be running inside the container, accessible at `http://localhost:3000` (or your mapped host port).

To stop the container:
```bash
docker stop my-mcp-graphql-server
```
To view logs:
```bash
docker logs my-mcp-graphql-server
```

## Testing with the Client

A simple test client script (`src/client.ts`) is included to demonstrate interacting with the server's tools.

1.  **Ensure the server is running** (either locally or in Docker) and configured correctly.
2.  **Run the client:**
    ```bash
    # Build the client code first (if not already done by npm run build)
    npx tsc src/client.ts
    # Run the compiled client
    node dist/client.js
    ```
    *Alternatively, use `ts-node` directly:* 
    ```bash
    npx ts-node src/client.ts
    ```

The client will connect to the server (using SSE transport by default), list the available tools, and call the GraphQL tools (`introspect-schema`, `query-graphql`) with example arguments. 

**Note:** 
*   You may need to adjust the sample query/variables in `src/client.ts` (Test #3) to match your specific GraphQL endpoint schema.
*   If you have configured the server with `MCP_API_KEY`, the client currently does **not** send the required `X-API-Key` header and will likely fail on tool calls. You would need to modify the client transport options to include this header, which can be complex with the standard SSE transport.

## Tool Details

### `introspect-schema`

Introspects the target GraphQL endpoint (or reads the local schema file) and returns the schema definition.

*   **Input Arguments:** None
*   **Output:** Text content containing the GraphQL Schema Definition Language (SDL).

### `query-graphql`

Executes a query or mutation against the target GraphQL endpoint.

*   **Input Arguments:**
    *   `query` (string, required): The GraphQL query or mutation string.
    *   `variables` (string, optional): A JSON string containing variables for the query/mutation.
*   **Output:** Text content containing the JSON response from the GraphQL endpoint (including `data` and/or `errors`).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 