import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AmodbApiError, MissingApiKeyError, seg, type AmodbClient } from './api.js';

export const TOOL_NAMES = [
  'search_titles',
  'get_movie',
  'get_tv_show',
  'get_season',
  'get_person',
  'find_by_external_id',
  'trending',
  'discover_movies',
  'get_showtimes',
] as const;

const DEFAULT_LIMIT = 10;
const DEFAULT_VENUES = 5;
const DEFAULT_SHOWTIMES_PER_VENUE = 10;

const MOVIE_APPEND = [
  'credits',
  'images',
  'videos',
  'keywords',
  'recommendations',
  'similar',
  'reviews',
  'release_dates',
  'watch/providers',
  'external_ids',
  'alternative_titles',
  'moods',
  'soundtracks',
  'ratings',
  'wikidata',
] as const;

const TV_APPEND = [
  'credits',
  'images',
  'videos',
  'keywords',
  'recommendations',
  'similar',
  'reviews',
  'content_ratings',
  'external_ids',
  'watch/providers',
  'alternative_titles',
  'episode_groups',
  'moods',
  'soundtracks',
  'ratings',
  'wikidata',
] as const;

const EXTERNAL_SOURCES = [
  'imdb_id',
  'freebase_mid',
  'freebase_id',
  'tvdb_id',
  'tvrage_id',
  'facebook_id',
  'twitter_id',
  'instagram_id',
  'tiktok_id',
  'youtube_id',
  'wikidata_id',
  'kinopoisk_id',
] as const;

const PERSON_APPEND = ['combined_credits', 'movie_credits', 'tv_credits', 'images', 'external_ids'] as const;

const DISCOVER_SORT = [
  'popularity.desc',
  'popularity.asc',
  'vote_average.desc',
  'vote_average.asc',
  'vote_count.desc',
  'vote_count.asc',
  'primary_release_date.desc',
  'primary_release_date.asc',
  'revenue.desc',
  'revenue.asc',
  'title.asc',
  'title.desc',
  'original_title.asc',
  'original_title.desc',
] as const;

const language = z
  .string()
  .min(2)
  .optional()
  .describe(
    'Language tag for titles and overviews, for example en-US, ru-RU or pt-BR. Served languages: en, ru, uk, be, zh, pt, bg, he, cs, ro, fr, pl, it, es. Any other tag falls back to English. Omit to use the server default.',
  );

const limit = z
  .number()
  .int()
  .min(1)
  .max(20)
  .optional()
  .describe(`Maximum number of results to return, 1 to 20. Default ${DEFAULT_LIMIT}. Keep it small to save context.`);

const page = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe('Result page number, starting at 1. Each page holds up to 20 results.');

function appendField(values: readonly [string, ...string[]], extra: string) {
  return z
    .array(z.enum(values))
    .optional()
    .describe(
      `Extra data to fetch in the same call, as a list. Allowed values: ${values.join(', ')}. ${extra} Each value makes the response larger, so request only what you need.`,
    );
}

/** Keep at most `max` items of `results` and say how many were returned. */
export function trimResults(data: unknown, max: number): unknown {
  if (data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)) {
    const record = data as Record<string, unknown> & { results: unknown[] };
    const results = record.results.slice(0, max);
    return { ...record, results, returned: results.length };
  }
  return data;
}

/**
 * Shape a showtimes reply: keep at most `maxVenues` venues and `maxPerVenue` showtimes per
 * venue. Each venue gets `showtimes_total`, the reply gets `venues_total`, `returned` and
 * `truncated`. The per-country `countries` summary is kept as is. A reply with no venues
 * (no country given, or nothing playing) is returned unchanged.
 */
export function shapeShowtimes(data: unknown, maxVenues: number, maxPerVenue: number): unknown {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { results?: unknown }).results)) return data;
  const record = data as Record<string, unknown> & { results: unknown[] };
  const venues = record.results;
  if (venues.length === 0) return data;
  let truncated = venues.length > maxVenues;
  const results = venues.slice(0, maxVenues).map((venue) => {
    if (!venue || typeof venue !== 'object' || !Array.isArray((venue as { showtimes?: unknown }).showtimes)) return venue;
    const entry = venue as Record<string, unknown> & { showtimes: unknown[] };
    if (entry.showtimes.length > maxPerVenue) truncated = true;
    return { ...entry, showtimes: entry.showtimes.slice(0, maxPerVenue), showtimes_total: entry.showtimes.length };
  });
  return { ...record, results, venues_total: venues.length, returned: results.length, truncated };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(err: unknown): CallToolResult {
  let text: string;
  if (err instanceof MissingApiKeyError || err instanceof AmodbApiError) {
    text = err.message;
  } else if (err instanceof Error) {
    text = `Unexpected error: ${err.message}`;
  } else {
    text = `Unexpected error: ${String(err)}`;
  }
  return { content: [{ type: 'text', text }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerTools(server: McpServer, client: AmodbClient): void {
  server.registerTool(
    'search_titles',
    {
      title: 'Search titles and people',
      description:
        'Search for movies, TV shows or people by name. Call this first when you have a title or a name and need the numeric id that the other tools require. ' +
        'Returns the best matches with id, title or name, release date, overview and popularity, at most `limit` items (default 10). ' +
        'Use media_type "multi" (the default) when you do not know the kind; each result then carries a media_type field. ' +
        'The year filter only applies to movie (release year) and tv (first air year).',
      inputSchema: {
        query: z.string().min(1).describe('Title or person name to search for, for example "Fight Club" or "Tom Hanks".'),
        media_type: z
          .enum(['movie', 'tv', 'person', 'multi'])
          .optional()
          .describe('What to search: movie, tv, person, or multi for all three. Default multi.'),
        year: z
          .number()
          .int()
          .min(1870)
          .max(2100)
          .optional()
          .describe('Release year for movie searches, or first air year for tv searches. Ignored for person and multi.'),
        page,
        language,
        limit,
      },
      annotations: READ_ONLY,
    },
    ({ query, media_type, year, page: pageNumber, language: lang, limit: max }) =>
      run(async () => {
        const type = media_type ?? 'multi';
        const data = await client.get(`/search/${seg(type)}`, {
          query,
          year: type === 'movie' ? year : undefined,
          first_air_date_year: type === 'tv' ? year : undefined,
          page: pageNumber,
          language: lang,
        });
        return trimResults(data, max ?? DEFAULT_LIMIT);
      }),
  );

  server.registerTool(
    'get_movie',
    {
      title: 'Get movie details',
      description:
        'Get the full record of one movie by its numeric id: title, overview, runtime, genres, release date, budget, revenue, status and vote average. ' +
        'Use append to add related data in the same call: credits for cast and crew, videos for trailers, release_dates for age certifications, ' +
        'watch/providers for where to stream, external_ids for the IMDb and Kinopoisk ids, keywords, recommendations, similar and alternative_titles. ' +
        'The reviews section is empty for most titles. ' +
        'The amodb extras are also appended: ratings (imdb, kinopoisk, tmdb out of 10, metacritic and rotten_tomatoes out of 100, each as value and votes or null), ' +
        'moods (meters named action, fear, humor and so on, avg on a 0 to 10 scale, source measured or estimated), soundtracks (albums with tracks) ' +
        'and wikidata (budget, box office, sequels, awards, based_on). ' +
        'For cinema times use get_showtimes. Get the id from search_titles first.',
      inputSchema: {
        id: z.number().int().positive().describe('Numeric movie id, for example 550. Find it with search_titles.'),
        append: appendField(MOVIE_APPEND, 'Example: ["credits", "videos"].'),
        language,
      },
      annotations: READ_ONLY,
    },
    ({ id, append, language: lang }) =>
      run(() => client.get(`/movie/${seg(id)}`, { append_to_response: append, language: lang })),
  );

  server.registerTool(
    'get_tv_show',
    {
      title: 'Get TV show details',
      description:
        'Get the full record of one TV show by its numeric id: name, overview, genres, networks, status, number of seasons and episodes, and the list of seasons. ' +
        'Use append to add related data in the same call: credits for cast and crew, videos for trailers, content_ratings for age ratings, ' +
        'watch/providers for where to stream, external_ids for the IMDb, TVDB and Kinopoisk ids, keywords, recommendations, similar, alternative_titles and episode_groups. ' +
        'The reviews section and created_by are empty for most shows. ' +
        'The amodb extras moods, soundtracks, ratings and wikidata are also appended, with the same shapes as for movies. ' +
        'For cinema times use get_showtimes. Use get_season to list the episodes of one season. Get the id from search_titles first.',
      inputSchema: {
        id: z.number().int().positive().describe('Numeric TV show id, for example 1399. Find it with search_titles.'),
        append: appendField(TV_APPEND, 'Example: ["credits", "content_ratings"].'),
        language,
      },
      annotations: READ_ONLY,
    },
    ({ id, append, language: lang }) =>
      run(() => client.get(`/tv/${seg(id)}`, { append_to_response: append, language: lang })),
  );

  server.registerTool(
    'get_season',
    {
      title: 'Get season and episodes',
      description:
        'Get one season of a TV show with its full episode list: episode number, name, air date, runtime, overview and vote average for each episode. ' +
        'Use it to answer questions about episodes, air dates or season length. Season number 0 holds the specials. ' +
        'You need the TV show id from search_titles or get_tv_show.',
      inputSchema: {
        tv_id: z.number().int().positive().describe('Numeric TV show id, for example 1399.'),
        season_number: z
          .number()
          .int()
          .min(0)
          .describe('Season number, starting at 1. Use 0 for specials.'),
        language,
      },
      annotations: READ_ONLY,
    },
    ({ tv_id, season_number, language: lang }) =>
      run(() => client.get(`/tv/${seg(tv_id)}/season/${seg(season_number)}`, { language: lang })),
  );

  server.registerTool(
    'get_person',
    {
      title: 'Get person details',
      description:
        'Get the record of one actor, director or other crew member by numeric id: name, biography, birth and death dates, place of birth and known department. ' +
        'Use append to add combined_credits for the full filmography (movies and TV together), movie_credits or tv_credits for one kind, images for photos, or external_ids for the IMDb id. ' +
        'Get the id from search_titles with media_type person.',
      inputSchema: {
        id: z.number().int().positive().describe('Numeric person id, for example 287. Find it with search_titles.'),
        append: appendField(PERSON_APPEND, 'Example: ["combined_credits"].'),
        language,
      },
      annotations: READ_ONLY,
    },
    ({ id, append, language: lang }) =>
      run(() => client.get(`/person/${seg(id)}`, { append_to_response: append, language: lang })),
  );

  server.registerTool(
    'find_by_external_id',
    {
      title: 'Find by external id',
      description:
        'Look up a movie, TV show or person by an id from another system, when you do not have the amodb numeric id. ' +
        'Typical use: the user gives an IMDb id such as tt0137523 (titles) or nm0000093 (people), a Kinopoisk id (digits), or a Wikidata id (Q followed by digits). ' +
        'Returns movie_results, tv_results and person_results, each item with a media_type; take the id from the matching list and pass it to get_movie, get_tv_show or get_person. ' +
        'The result also has tv_episode_results and tv_season_results, which are always empty. ' +
        'A missing or unknown external_source, or a malformed id, is an error.',
      inputSchema: {
        external_id: z.string().min(1).describe('The id to look up, for example tt0137523, 361 or Q35332.'),
        external_source: z
          .enum(EXTERNAL_SOURCES)
          .describe(
            'Which id system external_id belongs to: imdb_id for ids that start with tt or nm, kinopoisk_id for Kinopoisk digits, wikidata_id for Q ids, ' +
              'tvdb_id, facebook_id, twitter_id or instagram_id. The other values (freebase_mid, freebase_id, tvrage_id, tiktok_id, youtube_id) are accepted but return nothing.',
          ),
      },
      annotations: READ_ONLY,
    },
    ({ external_id, external_source }) =>
      run(() => client.get(`/find/${seg(external_id)}`, { external_source })),
  );

  server.registerTool(
    'trending',
    {
      title: 'Trending titles',
      description:
        'List what is trending now: movies, TV shows, people, or all three mixed. Use it for questions like "what is popular today" or "what are people watching this week". ' +
        'Returns at most `limit` items (default 10), most popular first.',
      inputSchema: {
        media_type: z
          .enum(['all', 'movie', 'tv', 'person'])
          .optional()
          .describe('What to list: all, movie, tv or person. Default all.'),
        time_window: z.enum(['day', 'week']).optional().describe('Trending over the last day or the last week. Default day.'),
        language,
        limit,
      },
      annotations: READ_ONLY,
    },
    ({ media_type, time_window, language: lang, limit: max }) =>
      run(async () => {
        const data = await client.get(`/trending/${seg(media_type ?? 'all')}/${seg(time_window ?? 'day')}`, {
          language: lang,
        });
        return trimResults(data, max ?? DEFAULT_LIMIT);
      }),
  );

  server.registerTool(
    'discover_movies',
    {
      title: 'Discover movies by filter',
      description:
        'Find movies by filters instead of a name: genre, release year, minimum rating, original language, region and sort order. ' +
        'Use it for requests like "best rated sci-fi from 2010" or "popular French comedies". ' +
        'Returns at most `limit` movies (default 10). ' +
        'Common genre ids: 28 Action, 12 Adventure, 16 Animation, 35 Comedy, 80 Crime, 99 Documentary, 18 Drama, 10751 Family, 14 Fantasy, 36 History, 27 Horror, 10402 Music, 9648 Mystery, 10749 Romance, 878 Science Fiction, 53 Thriller, 10752 War, 37 Western. ' +
        'When you sort by vote_average, also set vote_count_gte (for example 200) so that titles with a handful of votes do not lead the list.',
      inputSchema: {
        with_genres: z
          .array(z.number().int().positive())
          .optional()
          .describe('Genre ids. A movie must match all of them. Example: [878, 12] for science fiction and adventure.'),
        primary_release_year: z
          .number()
          .int()
          .min(1870)
          .max(2100)
          .optional()
          .describe('Only movies whose primary release year is this year, for example 2010.'),
        sort_by: z
          .enum(DISCOVER_SORT)
          .optional()
          .describe('Sort order, for example popularity.desc (default) or vote_average.desc.'),
        vote_average_gte: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe('Minimum vote average on a 0 to 10 scale, for example 7.5.'),
        vote_count_gte: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Minimum number of votes, for example 500. Filters out titles with too few votes to trust.'),
        with_original_language: z
          .string()
          .min(2)
          .max(3)
          .optional()
          .describe('Original language as an ISO 639-1 code, for example fr, ja or ru.'),
        region: z
          .string()
          .length(2)
          .optional()
          .describe('ISO 3166-1 country code, for example US or DE. Used for release dates and certifications.'),
        page,
        language,
        limit,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const data = await client.get('/discover/movie', {
          with_genres: args.with_genres,
          primary_release_year: args.primary_release_year,
          sort_by: args.sort_by,
          'vote_average.gte': args.vote_average_gte,
          'vote_count.gte': args.vote_count_gte,
          with_original_language: args.with_original_language,
          region: args.region,
          page: args.page,
          language: args.language,
        });
        return trimResults(data, args.limit ?? DEFAULT_LIMIT);
      }),
  );

  server.registerTool(
    'get_showtimes',
    {
      title: 'Get cinema showtimes',
      description:
        'Find where and when a movie or TV title is showing in cinemas, from today on. ' +
        'Without country the reply lists the countries that have showtimes, each with counts of venues, cities and showtimes and the first and last day, most showtimes first; ' +
        'results is then empty. Call it again with a two letter country code (for example RU) to get the cinemas: name, chain, city, address, timezone, ' +
        'and per showtime the local start time, date, formats, auditorium, price and booking_url. ' +
        'Start times are local to the cinema. Output is limited to the first `max_venues` cinemas (default 5) and `max_showtimes_per_venue` showtimes each (default 10); ' +
        'showtimes_total and venues_total give the full counts. Many titles have no showtimes at all.',
      inputSchema: {
        media_type: z.enum(['movie', 'tv']).describe('Whether id is a movie or a TV show id.'),
        id: z.number().int().positive().describe('Numeric movie or TV show id. Find it with search_titles.'),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('ISO 3166-1 country code, for example RU or DE. Omit it to list the countries that have showtimes.'),
        max_venues: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(`Maximum number of cinemas to return, 1 to 50. Default ${DEFAULT_VENUES}.`),
        max_showtimes_per_venue: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe(`Maximum number of showtimes per cinema, 1 to 100. Default ${DEFAULT_SHOWTIMES_PER_VENUE}.`),
        language,
      },
      annotations: READ_ONLY,
    },
    ({ media_type, id, country, max_venues, max_showtimes_per_venue, language: lang }) =>
      run(async () => {
        const data = await client.get(`/${seg(media_type)}/${seg(id)}/showtimes`, {
          country: country?.toUpperCase(),
          language: lang,
        });
        return shapeShowtimes(data, max_venues ?? DEFAULT_VENUES, max_showtimes_per_venue ?? DEFAULT_SHOWTIMES_PER_VENUE);
      }),
  );
}
