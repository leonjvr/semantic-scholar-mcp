#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = "https://api.semanticscholar.org/graph/v1";
const RECOMMENDATIONS_BASE = "https://api.semanticscholar.org/recommendations/v1";

const API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || "";

const RATE_LIMIT_MESSAGE = `Rate limited by Semantic Scholar API. ${
  API_KEY
    ? "Your API key has an introductory rate limit of 1 request per second. Consider adding delays between requests."
    : "You are using the API without an API key. Unauthenticated requests share a pool of 1000 req/s across ALL users and are heavily throttled during peak times. To get your own API key with dedicated rate limits, request one at: https://www.semanticscholar.org/product/api#api-key-form"
}`;

const NO_API_KEY_NOTE =
  "Note: No API key configured. The server is using unauthenticated access with shared rate limits. For better reliability, set the SEMANTIC_SCHOLAR_API_KEY environment variable. Request a free API key at: https://www.semanticscholar.org/product/api#api-key-form";

// --- Rate limiting (queued to handle concurrent tool calls) ---

const MIN_REQUEST_INTERVAL_MS = 3000;
const MAX_RETRIES = 5;
let nextAllowedTime = 0;

async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  if (nextAllowedTime <= now) {
    // No wait needed, but reserve the next slot
    nextAllowedTime = now + MIN_REQUEST_INTERVAL_MS;
    return;
  }
  // Wait until our reserved slot
  const waitTime = nextAllowedTime - now;
  nextAllowedTime += MIN_REQUEST_INTERVAL_MS;
  await new Promise((resolve) => setTimeout(resolve, waitTime));
}

// --- HTTP helper ---

async function apiRequest(
  url: string,
  options: { method?: string; body?: unknown; params?: Record<string, string | undefined> } = {}
): Promise<unknown> {
  await enforceRateLimit();
  const { method = "GET", body, params } = options;
  const u = new URL(url);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") u.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": "semantic-scholar-mcp/1.0",
  };
  if (API_KEY) {
    headers["x-api-key"] = API_KEY;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  let lastRes: Response | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 3s, 6s, 12s, 24s, 48s
      const backoff = MIN_REQUEST_INTERVAL_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      // Also push out the next allowed time to avoid immediate follow-up collisions
      const now = Date.now();
      if (nextAllowedTime < now + MIN_REQUEST_INTERVAL_MS) {
        nextAllowedTime = now + MIN_REQUEST_INTERVAL_MS;
      }
    }

    lastRes = await fetch(u.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (lastRes.status !== 429) break;
  }

  const res = lastRes!;

  if (res.status === 429) {
    return { error: true, status: 429, message: RATE_LIMIT_MESSAGE + " (Retried " + MAX_RETRIES + " times with exponential backoff, still rate limited.)" };
  }
  if (res.status === 403) {
    return {
      error: true,
      status: 403,
      message:
        "Authentication error. Your API key may be invalid or expired. Request a new key at: https://www.semanticscholar.org/product/api#api-key-form",
    };
  }
  if (!res.ok) {
    const text = await res.text();
    return { error: true, status: res.status, message: text };
  }

  return res.json();
}

function formatResult(data: unknown): string {
  if (data && typeof data === "object" && "error" in (data as Record<string, unknown>)) {
    return JSON.stringify(data, null, 2);
  }
  return JSON.stringify(data, null, 2);
}

// --- Paper fields description (shared) ---

const PAPER_FIELDS_DESC = `Comma-separated list of fields to return. Available fields: paperId, corpusId, externalIds, url, title, abstract, venue, publicationVenue, year, referenceCount, citationCount, influentialCitationCount, isOpenAccess, openAccessPdf, fieldsOfStudy, s2FieldsOfStudy, publicationTypes, publicationDate, journal, citationStyles, authors, citations, references, embedding, tldr, textAvailability. Use dot notation for subfields: authors.url, citations.title, embedding.specter_v2, etc. Default: paperId,title`;

const PAPER_ID_DESC = `Paper identifier. Supported formats: <sha> (Semantic Scholar ID), CorpusId:<id>, DOI:<doi>, ARXIV:<id>, MAG:<id>, ACL:<id>, PMID:<id>, PMCID:<id>, URL:<url>`;

const AUTHOR_FIELDS_DESC = `Comma-separated list of fields to return. Available: authorId, externalIds, url, name, affiliations, homepage, paperCount, citationCount, hIndex, papers. Use dot notation for paper subfields: papers.year, papers.authors, etc. Default: authorId,name`;

// --- MCP Server ---

const server = new McpServer({
  name: "semantic-scholar",
  version: "1.0.0",
});

// 1. Paper Relevance Search
server.tool(
  "paper_search",
  `Search for papers by relevance to a query. Returns up to 1000 results (paginated, max 100 per call). ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    query: z.string().describe("Plain-text search query string"),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
    publicationDateOrYear: z
      .string()
      .optional()
      .describe("Date range filter, e.g. 2019-03-05:2020-06-06, 2019, 2016-2020"),
    year: z.string().optional().describe("Year range, e.g. 2019, 2016-2020, 2010-, -2015"),
    venue: z.string().optional().describe("Comma-separated venue names"),
    fieldsOfStudy: z
      .string()
      .optional()
      .describe(
        "Comma-separated fields: Computer Science, Medicine, Chemistry, Biology, Materials Science, Physics, Geology, Psychology, Art, History, Geography, Sociology, Business, Political Science, Economics, Philosophy, Mathematics, Engineering, Environmental Science, Agricultural and Food Sciences, Education, Law, Linguistics"
      ),
    publicationTypes: z
      .string()
      .optional()
      .describe(
        "Comma-separated types: Review, JournalArticle, CaseReport, ClinicalTrial, Conference, Dataset, Editorial, LettersAndComments, MetaAnalysis, News, Study, Book, BookSection"
      ),
    openAccessPdf: z.string().optional().describe("Include only papers with open access PDF (pass empty string)"),
    minCitationCount: z.string().optional().describe("Minimum citation count"),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Results per page, max 100 (default 100)"),
  },
  async ({ query, fields, publicationDateOrYear, year, venue, fieldsOfStudy, publicationTypes, openAccessPdf, minCitationCount, offset, limit }) => {
    const data = await apiRequest(`${API_BASE}/paper/search`, {
      params: {
        query,
        fields,
        publicationDateOrYear,
        year,
        venue,
        fieldsOfStudy,
        publicationTypes,
        openAccessPdf,
        minCitationCount,
        offset: offset?.toString(),
        limit: limit?.toString(),
      },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 2. Paper Bulk Search
server.tool(
  "paper_bulk_search",
  `Bulk search for papers with boolean query syntax. Returns up to 1000 per call, supports token-based pagination for up to 10M results. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    query: z
      .string()
      .optional()
      .describe(
        "Text query with boolean syntax: + (AND), | (OR), - (negate), quotes for phrases, * prefix match, ~N edit distance, parentheses for grouping"
      ),
    token: z.string().optional().describe("Continuation token from previous bulk search response"),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
    sort: z
      .string()
      .optional()
      .describe("Sort by: paperId, publicationDate, citationCount. Format: field:order (e.g. citationCount:desc)"),
    publicationDateOrYear: z.string().optional().describe("Date range filter"),
    year: z.string().optional().describe("Year range filter"),
    venue: z.string().optional().describe("Comma-separated venue names"),
    fieldsOfStudy: z.string().optional().describe("Comma-separated fields of study"),
    publicationTypes: z.string().optional().describe("Comma-separated publication types"),
    openAccessPdf: z.string().optional().describe("Include only papers with open access PDF"),
    minCitationCount: z.string().optional().describe("Minimum citation count"),
  },
  async ({ query, token, fields, sort, publicationDateOrYear, year, venue, fieldsOfStudy, publicationTypes, openAccessPdf, minCitationCount }) => {
    const data = await apiRequest(`${API_BASE}/paper/search/bulk`, {
      params: {
        query,
        token,
        fields,
        sort,
        publicationDateOrYear,
        year,
        venue,
        fieldsOfStudy,
        publicationTypes,
        openAccessPdf,
        minCitationCount,
      },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 3. Paper Title Search (match)
server.tool(
  "paper_title_search",
  `Find a single paper by closest title match. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    query: z.string().describe("Paper title to search for"),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
    publicationDateOrYear: z.string().optional().describe("Date range filter"),
    year: z.string().optional().describe("Year range filter"),
    venue: z.string().optional().describe("Comma-separated venue names"),
    fieldsOfStudy: z.string().optional().describe("Comma-separated fields of study"),
    publicationTypes: z.string().optional().describe("Comma-separated publication types"),
    openAccessPdf: z.string().optional().describe("Include only papers with open access PDF"),
    minCitationCount: z.string().optional().describe("Minimum citation count"),
  },
  async ({ query, fields, publicationDateOrYear, year, venue, fieldsOfStudy, publicationTypes, openAccessPdf, minCitationCount }) => {
    const data = await apiRequest(`${API_BASE}/paper/search/match`, {
      params: { query, fields, publicationDateOrYear, year, venue, fieldsOfStudy, publicationTypes, openAccessPdf, minCitationCount },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 4. Paper Details
server.tool(
  "paper_details",
  `Get detailed information about a specific paper. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    paper_id: z.string().describe(PAPER_ID_DESC),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
  },
  async ({ paper_id, fields }) => {
    const data = await apiRequest(`${API_BASE}/paper/${encodeURIComponent(paper_id)}`, {
      params: { fields },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 5. Paper Authors
server.tool(
  "paper_authors",
  `Get the authors of a specific paper. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    paper_id: z.string().describe(PAPER_ID_DESC),
    fields: z.string().optional().describe(AUTHOR_FIELDS_DESC),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Results per page, max 1000 (default 100)"),
  },
  async ({ paper_id, fields, offset, limit }) => {
    const data = await apiRequest(`${API_BASE}/paper/${encodeURIComponent(paper_id)}/authors`, {
      params: { fields, offset: offset?.toString(), limit: limit?.toString() },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 6. Paper Citations
server.tool(
  "paper_citations",
  `Get papers that cite a specific paper. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    paper_id: z.string().describe(PAPER_ID_DESC),
    fields: z
      .string()
      .optional()
      .describe(
        "Comma-separated fields for the citing papers. Available: contexts, intents, isInfluential, plus any paper fields (title, abstract, authors, etc.). Default: paperId,title"
      ),
    publicationDateOrYear: z.string().optional().describe("Filter citations by publication date range"),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Results per page, max 1000 (default 100)"),
  },
  async ({ paper_id, fields, publicationDateOrYear, offset, limit }) => {
    const data = await apiRequest(`${API_BASE}/paper/${encodeURIComponent(paper_id)}/citations`, {
      params: { fields, publicationDateOrYear, offset: offset?.toString(), limit: limit?.toString() },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 7. Paper References
server.tool(
  "paper_references",
  `Get papers referenced by a specific paper (its bibliography). ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    paper_id: z.string().describe(PAPER_ID_DESC),
    fields: z
      .string()
      .optional()
      .describe(
        "Comma-separated fields for the referenced papers. Available: contexts, intents, isInfluential, plus any paper fields. Default: paperId,title"
      ),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Results per page, max 1000 (default 100)"),
  },
  async ({ paper_id, fields, offset, limit }) => {
    const data = await apiRequest(`${API_BASE}/paper/${encodeURIComponent(paper_id)}/references`, {
      params: { fields, offset: offset?.toString(), limit: limit?.toString() },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 8. Paper Autocomplete
server.tool(
  "paper_autocomplete",
  `Get paper title suggestions for interactive query completion. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    query: z.string().describe("Partial query string (max 100 characters)"),
  },
  async ({ query }) => {
    const data = await apiRequest(`${API_BASE}/paper/autocomplete`, {
      params: { query },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 9. Paper Batch
server.tool(
  "paper_batch",
  `Get details for multiple papers at once (max 500 IDs). ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    ids: z.array(z.string()).describe("Array of paper IDs (max 500). Supports same ID formats as paper_details."),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
  },
  async ({ ids, fields }) => {
    const data = await apiRequest(`${API_BASE}/paper/batch`, {
      method: "POST",
      params: { fields },
      body: { ids },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 10. Author Search
server.tool(
  "author_search",
  `Search for authors by name. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    query: z.string().describe("Author name to search for"),
    fields: z.string().optional().describe(AUTHOR_FIELDS_DESC),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Results per page, max 1000 (default 100)"),
  },
  async ({ query, fields, offset, limit }) => {
    const data = await apiRequest(`${API_BASE}/author/search`, {
      params: { query, fields, offset: offset?.toString(), limit: limit?.toString() },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 11. Author Details
server.tool(
  "author_details",
  `Get detailed information about a specific author. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    author_id: z.string().describe("Semantic Scholar author ID"),
    fields: z.string().optional().describe(AUTHOR_FIELDS_DESC),
  },
  async ({ author_id, fields }) => {
    const data = await apiRequest(`${API_BASE}/author/${encodeURIComponent(author_id)}`, {
      params: { fields },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 12. Author Papers
server.tool(
  "author_papers",
  `Get papers by a specific author. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    author_id: z.string().describe("Semantic Scholar author ID"),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
    publicationDateOrYear: z.string().optional().describe("Date range filter"),
    offset: z.number().optional().describe("Pagination offset (default 0)"),
    limit: z.number().optional().describe("Results per page, max 1000 (default 100)"),
  },
  async ({ author_id, fields, publicationDateOrYear, offset, limit }) => {
    const data = await apiRequest(`${API_BASE}/author/${encodeURIComponent(author_id)}/papers`, {
      params: { fields, publicationDateOrYear, offset: offset?.toString(), limit: limit?.toString() },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 13. Author Batch
server.tool(
  "author_batch",
  `Get details for multiple authors at once (max 1000 IDs). ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    ids: z.array(z.string()).describe("Array of author IDs (max 1000)"),
    fields: z.string().optional().describe(AUTHOR_FIELDS_DESC),
  },
  async ({ ids, fields }) => {
    const data = await apiRequest(`${API_BASE}/author/batch`, {
      method: "POST",
      params: { fields },
      body: { ids },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 14. Recommendations (single paper)
server.tool(
  "recommendations_single",
  `Get paper recommendations based on a single paper. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    paper_id: z.string().describe(PAPER_ID_DESC),
    from: z
      .enum(["recent", "all-cs"])
      .optional()
      .describe("Pool to recommend from: 'recent' (default) or 'all-cs'"),
    limit: z.number().optional().describe("Number of recommendations, max 500 (default 100)"),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
  },
  async ({ paper_id, from, limit, fields }) => {
    const data = await apiRequest(`${RECOMMENDATIONS_BASE}/papers/forpaper/${encodeURIComponent(paper_id)}`, {
      params: { from, limit: limit?.toString(), fields },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 15. Recommendations (multi paper)
server.tool(
  "recommendations_multi",
  `Get paper recommendations based on multiple positive and negative example papers. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    positivePaperIds: z.array(z.string()).describe("Paper IDs to use as positive examples"),
    negativePaperIds: z.array(z.string()).optional().describe("Paper IDs to use as negative examples"),
    limit: z.number().optional().describe("Number of recommendations, max 500 (default 100)"),
    fields: z.string().optional().describe(PAPER_FIELDS_DESC),
  },
  async ({ positivePaperIds, negativePaperIds, limit, fields }) => {
    const data = await apiRequest(`${RECOMMENDATIONS_BASE}/papers/`, {
      method: "POST",
      params: { limit: limit?.toString(), fields },
      body: { positivePaperIds, negativePaperIds: negativePaperIds || [] },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// 16. Snippet Search
server.tool(
  "snippet_search",
  `Search for text snippets within papers. Returns ~500-word excerpts from paper titles, abstracts, and body text that match the query. ${!API_KEY ? NO_API_KEY_NOTE : ""}`,
  {
    query: z.string().describe("Plain-text search query"),
    limit: z.number().optional().describe("Number of results, max 1000 (default 10)"),
    fields: z
      .string()
      .optional()
      .describe(
        "Fields under the snippet section: snippet.text, snippet.snippetKind, snippet.annotations.sentences, etc."
      ),
    paperIds: z.string().optional().describe("Comma-separated paper IDs to restrict search to"),
    authors: z
      .string()
      .optional()
      .describe("Comma-separated author names (AND logic, fuzzy matching)"),
    publicationDateOrYear: z.string().optional().describe("Date range filter"),
    year: z.string().optional().describe("Year range filter"),
    venue: z.string().optional().describe("Comma-separated venue names"),
    fieldsOfStudy: z.string().optional().describe("Comma-separated fields of study"),
    minCitationCount: z.string().optional().describe("Minimum citation count"),
  },
  async ({ query, limit, fields, paperIds, authors, publicationDateOrYear, year, venue, fieldsOfStudy, minCitationCount }) => {
    const data = await apiRequest(`${API_BASE}/snippet/search`, {
      params: {
        query,
        limit: limit?.toString(),
        fields,
        paperIds,
        authors,
        publicationDateOrYear,
        year,
        venue,
        fieldsOfStudy,
        minCitationCount,
      },
    });
    return { content: [{ type: "text" as const, text: formatResult(data) }] };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
