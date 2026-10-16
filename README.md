# Leo as a Service — canonical sales page

A minimal, zero-build static sales page designed for GitHub Pages.

## What is included

- `index.html` — canonical sales page (agent eval calibration offer)
- `meet-leo.html` — the human half: background, track record, proof in progress
- `meet-marvin.html` — the agent half: Marvin's role, his evals, known failures
- `styles.css` — simple editorial styling using system fonts only
- `config.js` — paid Cal.com booking URL
- `script.js` — connects every CTA to the booking URL and preserves incoming query parameters
- `vsl-script.md` — short script for the placeholder VSL

## Setup

1. Create a new GitHub repository.
2. Upload these files to the root of the repo.
3. Edit `config.js` and replace the placeholder with your paid Cal.com booking link.
4. In GitHub, open **Settings → Pages**.
5. Set **Source** to deploy from a branch, then choose `main` and `/ (root)`.

No build step, framework, package manager, or external fonts are required.

## Design principles

The offer is now evals for people who already run a named agent. Marvin is back, but only as proof: his evals and failures live on their own page. Creator APIs, BiPU and broader theory stay out of the sales flow.

The page only tries to answer:

1. What do you do?
2. Why should I believe you?
3. How does this work?
4. What do I do next?

The visual style is intentionally plain and editorial rather than SaaS-like: system font, minimal tracking, restrained color, no gradients, no animated effects, and no large blocks of selectively bolded copy.
