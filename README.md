# Leo as a Service — canonical sales page

A minimal, zero-build static sales page designed for GitHub Pages, with a native Marvin discovery page and a separately deployed public-site scanner.

## What is included

- `index.html` — canonical business-leverage sales page
- `talk-to-marvin.html` — text-first Marvin discovery with optional voice, site scan, handoff, and data boundaries
- `proof.html` — public proof ledger separating outcomes, interim evidence, experiments, and unknowns
- `meet-leo.html` — the human half: background, track record, proof in progress
- `meet-marvin.html` — the agent half: Marvin's role, his evals, known failures
- `styles.css` — simple editorial styling using system fonts only
- `config.js` — paid Cal.com booking URL, public Marvin agent ID, and scanner endpoint
- `script.js` — connects every CTA to the booking URL and preserves incoming query parameters
- `scanner-worker/` — Cloudflare Worker + Durable Object source for bounded public website context scans
- `vsl-script.md` — short script for the placeholder VSL

## Setup

1. Create a new GitHub repository.
2. Upload these files to the root of the repo.
3. Edit `config.js` and replace the placeholder with your paid Cal.com booking link.
4. In GitHub, open **Settings → Pages**.
5. Set **Source** to deploy from a branch, then choose `main` and `/ (root)`.

No build step, framework, package manager, or external fonts are required.

## Design principles

The offer starts with listening to a business problem. Marvin is the first point of contact; agent evaluations remain a specialist application of the broader business-leverage engagement. The proof page separates acquisition activity from verified business outcomes. Creator APIs, BiPU and broader theory stay out of the sales flow.

The page only tries to answer:

1. What do you do?
2. Why should I believe you?
3. How does this work?
4. What do I do next?

The visual style is intentionally plain and editorial rather than SaaS-like: system font, minimal tracking, restrained color, no gradients, no animated effects, and no large blocks of selectively bolded copy.
