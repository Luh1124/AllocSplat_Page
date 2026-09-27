# AllocSplat project page

Static project page for *AllocSplat: Spatial Allocation for Budget-Adaptive Feed-Forward Gaussian Splatting*.

- `index.html` — the page (no build step, no external requests; it also works when opened from disk).
- `assets/viewer.js` — WebGL2 viewer for the predicted Gaussians and anchors.
- `assets/data/` — per scene, view count and budget: the decoded Gaussians and anchors (base64 in `.js` so the page also runs from `file://`), plus a per-anchor local-scale table.
- `assets/videos/` — fly-throughs rendered with the evaluation rasterizer.
- `assets/figures/`, `assets/fonts/` — paper figures and the bundled fonts (SIL OFL 1.1, see `assets/fonts/OFL.txt`).

## Publish on GitHub Pages

1. Push this folder as the root of a repository (or of a `gh-pages` branch).
2. In *Settings → Pages*, choose *Deploy from a branch*, select the branch and the root folder.
3. `.nojekyll` is included so that GitHub serves every file as is.

When the arXiv paper, code or model are released, replace the corresponding `<span class="soon">` in
`index.html` with a link, and update the BibTeX entry.
