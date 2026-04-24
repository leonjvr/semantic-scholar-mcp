# Semantic Scholar MCP Server

An MCP (Model Context Protocol) server that provides access to the [Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/). Search papers, authors, citations, get recommendations, and more — all from your AI assistant.

## Features

- **Paper Search** — relevance search, bulk search, title match, autocomplete
- **Paper Details** — full metadata, authors, citations, references
- **Batch Operations** — fetch multiple papers or authors in one call
- **Author Search & Details** — search by name, get papers, h-index, affiliations
- **Recommendations** — single-paper and multi-paper recommendations
- **Snippet Search** — full-text search within paper bodies
- **Rate Limit Handling** — clear error messages when rate limited, with guidance on getting an API key

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ installed

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/semantic-scholar-mcp.git
cd semantic-scholar-mcp
npm install
npm run build
```

### Configure Your MCP Client

#### VS Code

Add the following to your workspace or user `settings.json` (or create `.vscode/settings.json` in the project root):

**Without API key** (shared rate limits — may be throttled):

```json
{
  "mcp": {
    "servers": {
      "semantic-scholar": {
        "command": "node",
        "args": ["/absolute/path/to/semantic-scholar-mcp/dist/index.js"]
      }
    }
  }
}
```

**With API key** (recommended — dedicated rate limits):

```json
{
  "mcp": {
    "servers": {
      "semantic-scholar": {
        "command": "node",
        "args": ["/absolute/path/to/semantic-scholar-mcp/dist/index.js"],
        "env": {
          "SEMANTIC_SCHOLAR_API_KEY": "your-api-key-here"
        }
      }
    }
  }
}
```

> **Tip:** If the project is your workspace, you can use `"${workspaceFolder}/dist/index.js"` instead of an absolute path.

After saving, reload the VS Code window (`Ctrl+Shift+P` → "Developer: Reload Window") for the MCP server to be detected.

#### Claude Desktop

Add to your `claude_desktop_config.json`:

**Without API key:**

```json
{
  "mcpServers": {
    "semantic-scholar": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-scholar-mcp/dist/index.js"]
    }
  }
}
```

**With API key:**

```json
{
  "mcpServers": {
    "semantic-scholar": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-scholar-mcp/dist/index.js"],
      "env": {
        "SEMANTIC_SCHOLAR_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Getting an API Key

The API works without a key but with strict shared rate limits. For reliable access:

1. Go to [https://www.semanticscholar.org/product/api](https://www.semanticscholar.org/product/api)
2. Click **"Request an API Key"**
3. Fill out the form (academic/research use is prioritized)
4. You will receive your key via email
5. Add the key to your MCP configuration as shown above

The introductory rate limit with an API key is **1 request per second** on all endpoints.

## Available Tools

### Paper Tools

| Tool | Description |
|------|-------------|
| `paper_search` | Search papers by relevance (up to 1000 results, paginated) |
| `paper_bulk_search` | Bulk search with boolean query syntax (up to 10M results via pagination) |
| `paper_title_search` | Find a single paper by closest title match |
| `paper_details` | Get full details for a paper by ID (S2 ID, DOI, ArXiv, PMID, etc.) |
| `paper_authors` | Get authors of a paper |
| `paper_citations` | Get papers that cite a given paper |
| `paper_references` | Get papers referenced by a given paper |
| `paper_autocomplete` | Get title suggestions for interactive completion |
| `paper_batch` | Get details for up to 500 papers at once |

### Author Tools

| Tool | Description |
|------|-------------|
| `author_search` | Search authors by name |
| `author_details` | Get author profile (affiliations, h-index, paper count) |
| `author_papers` | Get papers by a specific author |
| `author_batch` | Get details for up to 1000 authors at once |

### Recommendation Tools

| Tool | Description |
|------|-------------|
| `recommendations_single` | Get recommendations based on one paper |
| `recommendations_multi` | Get recommendations from positive/negative paper examples |

### Text Tools

| Tool | Description |
|------|-------------|
| `snippet_search` | Search for text snippets within paper bodies (~500 word excerpts) |

## Supported Paper ID Formats

All paper tools accept these ID formats:

- `649def34f8be52c8b66281af98ae884c09aef38b` — Semantic Scholar SHA
- `CorpusId:215416146` — Semantic Scholar corpus ID
- `DOI:10.18653/v1/N18-3011` — Digital Object Identifier
- `ARXIV:2106.15928` — arXiv
- `MAG:112218234` — Microsoft Academic Graph
- `ACL:W12-3903` — ACL Anthology
- `PMID:19872477` — PubMed
- `PMCID:2323736` — PubMed Central
- `URL:https://arxiv.org/abs/2106.15928v1` — URL from supported sites

## Rate Limits

| Access Type | Rate Limit |
|-------------|-----------|
| No API key | 1000 req/s shared across ALL unauthenticated users |
| With API key | 1 req/s dedicated (introductory) |

When rate limited, the server returns a clear error message explaining the situation and how to obtain an API key.

## License

MIT
