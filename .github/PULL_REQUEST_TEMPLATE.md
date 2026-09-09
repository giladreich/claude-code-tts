## What this changes

<!-- One or two sentences. If it fixes an issue, "Fixes #123". -->

## Why

<!-- The user-visible problem. For audio changes, the measurement that shows the improvement. -->

## How it was verified

<!-- Commands you ran and what they printed; for audio, what you listened to. -->

- [ ] `npm test` passes (unit + integration + activation smoke)
- [ ] Tried the change in a real session (`npx vsce package`, install the .vsix, reload the window)

## Checklist

- [ ] `CHANGELOG.md` has a user-facing entry and `package.json` has the matching version
- [ ] New settings and commands are in the README tables (`test/unit/docs.test.js` enforces this)
- [ ] Works, or degrades with a clear message, on macOS, Linux and Windows (see the platform table in the README)
- [ ] No new runtime dependency; anything optional is detected at runtime with a fix suggested in "Check Setup"
- [ ] ASCII punctuation only, comments explain *why*, no emoji in code or docs
- [ ] Nothing new leaves the machine (docs/PRIVACY.md still accurate)
