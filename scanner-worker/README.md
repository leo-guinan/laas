# Marvin business context scanner

This Cloudflare Worker accepts a public business URL, crawls same-origin public HTML pages in a background Durable Object job, and stores a bounded source-labeled profile for the active conversation.

Endpoint:

- `POST /scan` with `{ "url": "https://example.com" }` returns a job id and bearer-like scan token.
- `GET /scan/:id?token=...` returns queued, scanning, complete, or error state.

The crawler follows same-origin sitemap entries and links discovered in public HTML. It reads at most 40 pages per job and stores page titles, descriptions, headings, text excerpts, and source URLs. It does not bypass authentication, execute site JavaScript, access private systems, or treat marketing claims as verified outcomes.

The scan token is returned only to the browser that starts the job. It is required to read the stored profile. The current storage is a private-by-token conversation profile; retention and deletion controls should be added before treating this as a long-term customer record.
