# Contributing

Keep contributions inside the narrow product boundary: a user-directed TypeScript bridge operating visible ChatGPT Chat through a compatible browser host.

Before a PR, run:

```bash
npm test
npm run build
npm run bundle
npm run plugin:build
npm run plugin:check
npm run plugin:validate
npm run pack:check
```

Changes to Send, tab/thread ownership, target selection, file readiness, output capture, artifacts, or the journal need focused fault tests. UI changes also need an opt-in real visible-session check.

Keep examples synthetic. Never commit `.codex/` state, prompts, responses, real thread URLs, filenames, account identifiers, credentials, cookies, tokens, or browser profiles.
