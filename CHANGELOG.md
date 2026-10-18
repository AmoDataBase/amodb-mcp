# Changelog

One section per version, newest first.

## Unreleased

### Added

- `get_showtimes` tool. `country` is optional: without it the reply lists the countries that have showtimes, with it the reply lists cinemas and times. Output is limited to `max_venues` cinemas and `max_showtimes_per_venue` showtimes each, with `venues_total`, `showtimes_total`, `returned` and `truncated`.
- `alternative_titles` in `append` for movies and TV, and `episode_groups` for TV.

### Changed

- Align the tools with the live API. `find_by_external_id` accepts all 12 external sources, including `kinopoisk_id` and `wikidata_id`, and no longer promises episode lookups.
- `get_movie` and `get_tv_show` descriptions state the shapes of the appended ratings, moods, soundtracks and Wikidata sections, and that reviews are empty for most titles.
- The language description lists the 14 served languages.
- The server instructions mention `get_showtimes`.
- Add CI, release and Dependabot workflows.
- Repository and package URLs now point to the amodb-dev organization.

### Removed

- `aggregate_credits` from the TV `append` values, because the API does not offer it.
- `showtimes` from the `append` values, now served by `get_showtimes`.

## 0.1.0 - 2026-10-18

### Added

- Initial release.
- Eight read only tools: `search_titles`, `get_movie`, `get_tv_show`, `get_season`, `get_person`, `find_by_external_id`, `trending`, `discover_movies`.
- Stdio transport, `AMODB_API_KEY`, `AMODB_LANGUAGE` and `AMODB_BASE_URL` settings.
- Retry on HTTP 429 and readable error messages.
