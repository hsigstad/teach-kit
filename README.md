# teach-kit

Shared front-end toolkit for Henrik Sigstad's course sites (ELE3786, MST0035, …):
the reveal.js + Supabase **live-poll** widget, the interactive **plot widget**, the
slide **theme**, the phone **vote** page, the **transcript** toggle, and the vendored
reveal.js library.

This repo is **public on purpose**: the course sites (GitHub Pages) already serve
these files publicly, and being public lets each course's CI pull the toolkit at
build time with **no secrets**. Nothing sensitive lives here — rules, exam
solutions, and case material stay in the private `teach` repo.

## Why this repo exists

Previously each course repo kept a **committed copy** of these files (vendored from
`teach/slides/` via a `vendor.sh`). That invited drift: a file hand-edited in one
course silently diverged from the source (it happened to `widget.js`). Here the
toolkit has a **single source of truth**. Courses fetch it at build time into their
`slides/reveal/` (git-ignored there), so there are no committed copies to drift.

## Files

| File | What it is |
|------|------------|
| `poll.js` | Live-poll presenter + phone voter (numeric / quiz / choicetext / free-text). Free-text answers auto-fit the slide. |
| `theme.css` | Slide theme + poll/widget styling. |
| `widget.js` | Interactive SVG plot widget (sliders, modes, `spec.layout`, axis ticks). |
| `vote.html` | The phone voting page a poll's QR code points to. |
| `transcript.js` | In-deck "Vis transkript" toggle. |
| `config.js` | Supabase project config for the live polls. |
| `_deck-template.html` | Starting-point template for a new deck. |
| `lib/` | Vendored reveal.js (+ Supabase / QR libs). |

## Consuming it from a course

Each course has a `slides/fetch-kit.sh` that clones this repo at a pinned tag and
copies the files it needs into `slides/reveal/`. Run it after cloning the course,
and whenever you want the latest toolkit. CI runs it before building the site.

```bash
# in a course repo
slides/fetch-kit.sh                       # pinned tag (default)
TEACH_KIT_REF=main slides/fetch-kit.sh    # bleeding edge
```

## Releasing a change

1. Edit the file(s) here, commit.
2. Move the release tag (e.g. `v1`) — or cut a new one — and push it.
3. Re-run `fetch-kit.sh` in each course (or let the next CI build pick it up) and
   deploy that course.

Bump the tag deliberately: a course only sees toolkit changes when its
`fetch-kit.sh` ref points at them.
