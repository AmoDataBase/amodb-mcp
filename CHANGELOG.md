# Changelog

One section per version, newest first.

## 0.1.0 - 2026-10-18

### Added

- Initial release.
- Eight read only tools: `search_titles`, `get_movie`, `get_tv_show`, `get_season`, `get_person`, `find_by_external_id`, `trending`, `discover_movies`.
- Stdio transport, `AMODB_API_KEY`, `AMODB_LANGUAGE` and `AMODB_BASE_URL` settings.
- Retry on HTTP 429 and readable error messages.
