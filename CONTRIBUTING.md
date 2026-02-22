# Contributing

Thanks for your interest in improving this extension!

## Getting started

1. Fork the repository and clone it locally
2. Run `./scripts/build.sh` to populate `dist/`
3. Load the extension in developer mode:
   - **Chrome**: `chrome://extensions` → enable Developer mode → Load unpacked → select `dist/chrome/`
   - **Firefox**: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select any file inside `dist/firefox/`
4. Edit files in `src/shared/`, `src/firefox/`, or `src/chrome/` as needed
5. Re-run `./scripts/build.sh` and reload the extension to pick up changes

## Project layout

All shared logic lives in `src/shared/`. Browser-specific files are only the manifest and icons (`src/chrome/`, `src/firefox/`). There is no bundler or build tool beyond `scripts/build.sh` — the extension is plain ES6 loaded directly by the browser.

See the [How It Works](README.md#how-it-works) section of the README for an overview of each feature's implementation.

## Submitting a pull request

- Keep changes focused — one feature or fix per PR
- Test in both Chrome and Firefox before opening a PR
- Include a short description of what changed and why in the PR body
- Screenshots or GIFs are welcome for UI changes

## Reporting bugs

Use the [bug report template](../../issues/new?template=bug_report.md). If Microsoft recently updated the Defender XDR portal UI, please mention it — DOM changes are the most common cause of breakage.
