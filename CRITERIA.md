# Criteria: BookLibrary frontend-only (no backend)

- [ ] Type query → first cards <1.5s; repeat search instant from cache
- [ ] Full "title + author" falls back, never zero when IA has it
- [ ] Exact-title uploads never flagged mismatch; junk demoted last
- [ ] Sort: mismatches bottom, then free → borrow → unknown → preview-only, then title-match score, then pages desc
- [ ] `node --check app.js` passes
- [ ] No fetch to /api/*, no Playwright, works as static files on Cloudflare Pages
- [ ] Each row: cover left; title, creator·year, description, full clickable archive.org URL, pages badge
- [ ] Access stamp per row from collections: Free to read / Borrow free / Preview only / Restricted
- [ ] Ratings row (OL average + count + want/read) with zero extra IA requests
- [ ] `?q=` in URL restores search on load
- [ ] Suggestion chips on hero and empty state; hero vertically centered; no rails, footer, or sort control
- [ ] Query words highlighted in titles and descriptions
- [ ] Animated searching status with live count; rows accumulate per query stage
- [ ] Download options button per row opens scrollable popup with all files grouped (main formats + more files); borrow/pay rows show access note instead
- [ ] Brand Find For Free; category selector Books/Video/Anime/Music with per-category mediatype, placeholders, ?cat= restore
