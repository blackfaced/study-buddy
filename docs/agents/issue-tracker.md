# Issue Tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

This repo is a personal, single-machine project with no GitHub/GitLab remote. The `to-issues`, `triage`, `to-prd`, and `qa` skills publish to and read from these files.

> **The `.scratch/` tree is gitignored.** These files are working notes for the Mavis session, not commit-able artifacts. They live on disk so the same session (or a fresh one launched in this workspace) can pick up where the last one left off.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD (when present) is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research` / `prototype` / `grilling` / `task`); a `Status:` line records `claimed` / `resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## Cleanup

`.scratch/` is ephemeral. When a feature ships and the working notes are no longer useful, delete the directory. Don't keep stale PRDs in version control — they belong in `docs/adr/` once they settle into a decision.
