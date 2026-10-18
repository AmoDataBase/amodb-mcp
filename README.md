<p align="center">
  <a href="https://amodb.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/amodb-dev/.github/main/assets/lockup-dark.png">
      <img src="https://raw.githubusercontent.com/amodb-dev/.github/main/assets/lockup-light.png" alt="amodb" width="260">
    </picture>
  </a>
</p>

<h1 align="center">amodb-mcp</h1>

<p align="center">MCP server for movie and TV data. Search titles and read full records from Claude, Cursor and VS Code.</p>

<p align="center">
  <a href="https://github.com/amodb-dev/amodb-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/amodb-dev/amodb-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/amodb-mcp"><img alt="npm version" src="https://img.shields.io/npm/v/amodb-mcp"></a>
  <a href="https://github.com/amodb-dev/amodb-mcp/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/amodb-dev/amodb-mcp"></a>
</p>

A Model Context Protocol server for movie and TV data. It lets Claude, Cursor, VS Code and other MCP clients search titles, read full movie, TV and person records, and check trending lists through the amodb API.

amodb is a paid API, get a key at https://amodb.dev/pricing. The API is compatible with TMDB v3, so the tools use the same ids and field names.

## Tools

| Tool | What it does |
|---|---|
| `search_titles` | Search movies, TV shows or people by name. Use it to get a numeric id. |
| `get_movie` | Full movie record. Add cast, trailers, release dates, streaming providers, ratings, moods, soundtracks, Wikidata facts and more with `append`. |
| `get_tv_show` | Full TV show record, with the same `append` options, with content ratings and episode groups instead of release dates. |
| `get_season` | One season with its episode list. |
| `get_person` | Actor or crew record. Add the full filmography with `combined_credits`. |
| `find_by_external_id` | Turn an IMDb id (for example `tt0137523`), a Kinopoisk id or a Wikidata id into an amodb id. |
| `trending` | Trending movies, TV shows or people, for the day or the week. |
| `discover_movies` | Find movies by genre, year, rating, language, region and sort order. |
| `get_showtimes` | Cinema showtimes for a movie or TV title. Without a country it lists the countries that have showtimes. With a country it lists cinemas and times. |

List tools return 10 items by default. Pass `limit` (1 to 20) to change that. `get_showtimes` returns 5 cinemas with 10 showtimes each by default, see `max_venues` and `max_showtimes_per_venue`, and reports the full counts. The `get_` tools return the full record, so use `append` only for what you need.

The tools cover what the amodb API serves. TMDB account, list, rating and session calls, aggregate credits and change feeds are not offered, so there is no tool for them.

## Install

You need Node 18 or newer and an amodb key. The client starts the server with `npx`, nothing to install by hand.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart the app:

```json
{
  "mcpServers": {
    "amodb": {
      "command": "npx",
      "args": ["-y", "amodb-mcp"],
      "env": {
        "AMODB_API_KEY": "your_key_here"
      }
    }
  }
}
```

### Cursor

Put the same block in `~/.cursor/mcp.json` for all projects, or in `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "amodb": {
      "command": "npx",
      "args": ["-y", "amodb-mcp"],
      "env": {
        "AMODB_API_KEY": "your_key_here"
      }
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json`. VS Code asks for the key once and keeps it out of the file:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "amodb-key",
      "description": "amodb API key",
      "password": true
    }
  ],
  "servers": {
    "amodb": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "amodb-mcp"],
      "env": {
        "AMODB_API_KEY": "${input:amodb-key}"
      }
    }
  }
}
```

### Local checkout

```sh
git clone https://github.com/amodb-dev/amodb-mcp
cd amodb-mcp
npm install
npm run build
```

Then point the client at the built file:

```json
{
  "mcpServers": {
    "amodb": {
      "command": "node",
      "args": ["/path/to/amodb-mcp/dist/index.js"],
      "env": {
        "AMODB_API_KEY": "your_key_here"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `AMODB_API_KEY` | Yes, for tool calls | Your amodb key. Without it the server starts, lists its tools, and every call returns an error. |
| `AMODB_LANGUAGE` | No | Default language for titles and overviews, for example `ru-RU` or `pt-BR`. A tool call can override it with `language`. |
| `AMODB_BASE_URL` | No | API base URL. Default `https://api.amodb.dev/3`. Mainly for tests. |

## Example prompts

- "Find Fight Club, then show its runtime, the top cast and where I can stream it."
- "What is trending on TV this week?"
- "Look up the IMDb id tt0137523 and tell me who directed it."
- "Show the IMDb, Rotten Tomatoes and Metacritic scores of Fight Club."
- "Which cinemas in Russia show Fight Club, and when?"
- "Find science fiction movies from 2010 with a rating of 7.5 or higher and at least 500 votes."

## Rate limits

Every plan gets all data. Plans differ only in requests per minute, see https://api.amodb.dev/plans. On a 429 response the server waits for the `Retry-After` time (at most 10 s) and retries up to 3 times, then returns the error to the model.

## Troubleshooting

- `AMODB_API_KEY is not set`: the client did not pass the `env` block. Check the config file and restart the client.
- HTTP 401 or 402: the key is wrong or the plan has expired. Check your account at https://amodb.dev.
- The client cannot start the server: check `node -v` (18 or newer). On Windows, if `npx` is not found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "amodb-mcp"]`.

Diagnostics go to stderr. Nothing except protocol messages is written to stdout.

## Development

```sh
npm install
npm run build
npm test
npm start
```

The tests run the built server over stdio against a local stub API, so they need no key and no network.

## Links

- Website: https://amodb.dev
- Docs: https://amodb.dev/docs
- Pricing: https://amodb.dev/pricing
- Status: https://amodb.dev/status
- Issues: https://github.com/amodb-dev/amodb-mcp/issues
- Changelog: https://github.com/amodb-dev/amodb-mcp/blob/main/CHANGELOG.md
- Security: https://github.com/amodb-dev/amodb-mcp/blob/main/SECURITY.md
- Organization: https://github.com/amodb-dev

## License

MIT, see [LICENSE](LICENSE).
