---
name: deepscientist-presentation
description: 'Route Science Mode presentation and research-dissemination work: reusable paper asset bundles, conference posters, bilingual research blogs, narrated videos, and interactive reel viewers. Use when the user asks to turn a paper, manuscript, Science artifact, report, notebook, or research result into presentation material, a poster, slides-adjacent package, blog/editorial copy, video, or a full shareable research communication pack.'
---

# DeepScientist Presentation

This is the Science Mode presentation and dissemination router. It turns an
existing research result into shareable artifacts while preserving
DeepScientist evidence, provenance, and artifact graph discipline.

Use this skill after there is a paper, manuscript, report, Science artifact,
or validated research result to present. Do not use it as a substitute for
evidence gathering, data analysis, or scientific validation.

## Core Contract

- `deepscientist-science` and `deepscientist-science-artifact` remain the
  controlling contract for evidence, claims, provenance, snapshots, and final
  reports.
- Presentation outputs must not introduce new scientific claims unless those
  claims are registered as evidence-backed Science claims first.
- Reuse one shared presentation bundle for every stage. Prefer a single
  `<project>/presentations/<slug>/` or artifact-local output folder.
- Keep deliverables inspectable in the normal Preview frame. Do not create a
  parallel dashboard or report rail.
- Record this skill as `skill_use` before relying on its workflow for a visible
  result.

## Progressive Disclosure

Read only the reference needed for the requested deliverable.

| Need                                                                                                        | Read                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Understand the full Microsoft Reel pipeline                                                                 | `references/researchstudio-reel-overview.md`                                         |
| Extract a PDF/paper/manuscript into reusable text, figure, caption, metadata, narration, and section assets | `references/paper2assets.md`                                                         |
| Create a conference poster, poster HTML/PDF/PNG, or editable poster PPTX                                    | `references/paper2poster.md`                                                         |
| Create bilingual editorial/blog/docx outputs                                                                | `references/paper2blog.md`                                                           |
| Create narrated video, PPTX, MP4, subtitles, timing, and visual-cue metadata                                | `references/paper2video.md`                                                          |
| Assemble poster, blog, slides/video, and downloads into one interactive viewer                              | `references/paper2reel.md`                                                           |
| Check lightweight Python dependencies from the upstream workflow                                            | `references/paper2poster-requirements.txt`, `references/paper2blog-requirements.txt` |

The `paper2reel` reference is the main assembly model for a full package. It
should orchestrate missing upstream stages rather than replace them.

## Recommended Output Shape

Use a self-contained bundle:

```text
<presentation_outdir>/
  manifest.json
  poster.html
  poster.pdf
  poster.png
  poster.pptx
  blog_zh.docx
  blog_en.docx
  video.mp4
  video_no_subtitles.mp4
  video.pptx
  reel.html
  content_alignment.json
  assets/
    figures/
    logos/
    qr/
    audio/
    slides/
    media/
    blog/
    downloads/
    meta/
      paper_spec.md
      text.txt
      figures.json
      captions.json
      metadata.json
      sections.json
      narration.json
      reports/
      previews/
```

Not every deliverable is required. The top-level files should match the user's
request; dependencies, intermediate files, QA reports, previews, and copied
assets stay under `assets/`.

## Routing SOP

1. Identify the requested presentation target: assets, poster, blog, video,
   reel, or full communication pack.
2. Inspect the current Science artifact state and project root. Reuse an
   existing report, manuscript, PDF, notebook, figure, or run bundle when the
   user is referring to prior work.
3. Create or update a Science artifact for the presentation bundle before
   producing visible files.
4. If a reusable assets bundle is absent, read `references/paper2assets.md` and
   build the shared asset layer first.
5. For a single deliverable, read only that deliverable's reference and reuse
   the shared asset layer.
6. For a full package or reel, read `references/paper2reel.md` first, then only
   the missing upstream references it requires. Default order:
   `paper2assets -> paper2poster -> paper2blog -> paper2video -> paper2reel`.
7. Prefer existing DeepScientist local skills when they already cover the
   requested format:
   - Posters: `kdense-latex-posters` or `kdense-pptx-posters` when the user
     explicitly requests LaTeX/PPTX poster behavior.
   - Academic slide decks: `ds-nature-paper2ppt`, `nature-paper2ppt`, or
     `kdense-scientific-slides`.
   - DOCX/Markdown conversion: `kdense-docx`, `aer-md-to-docx`, or document
     tooling.
     Use the Reel references for the shared bundle contract and final assembly.
8. Snapshot every meaningful output and include generated source files,
   command logs, previews, QA reports, and environment notes. Never snapshot
   secrets or credentials.
9. Publish through `science_artifact(action="publish")` before final response.

## Quality Gates

- Poster/page layouts need rendered visual inspection: no clipped text, no
  overlapping elements, no unreadable tiny labels, no broken images.
- Blog/DOCX outputs need shared figure sets, aligned facts across languages,
  no TODO placeholders, and source links only when verified.
- Video outputs need playable MP4, subtitle timing, speaker-note/script match,
  and a no-subtitle copy for reel playback.
- Reel outputs need a browser smoke test: poster-first default view,
  section-level modal, copied assets, downloads, slide/video seeking, and
  captions. Range-capable serving is required for real video seeking checks.
- If a dependency is missing, record the exact missing package/tool and either
  use a declared fallback or stop before pretending the deliverable is complete.

## Safety And Scientific Boundaries

- Medical or clinical content keeps the original evidence boundary: preserve
  uncertainty, contraindications, citations, and clinical caveats. A poster,
  blog, or video must not simplify away risk language.
- Dissemination copy can clarify and compress, but it cannot add unsupported
  novelty, performance numbers, affiliations, acceptance status, DOI, code URL,
  or clinical recommendation.
- If user-facing prose is generated in multiple languages, keep facts, numbers,
  figures, and claim scope aligned. Style may differ; evidence cannot.

## Source

Adapted as a DeepScientist router from Microsoft ResearchStudio-Reel:
https://github.com/microsoft/ResearchStudio/tree/main/ResearchStudio-Reel

The upstream reference files remain under `references/` for auditability and
progressive disclosure. Treat them as workflow guidance, not as scientific
evidence.
