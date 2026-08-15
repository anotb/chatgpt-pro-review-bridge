# ChatGPT Bridge Agent Instructions

## Public boundary

- This is an unofficial public-alpha bridge for user-directed workflows in visible ChatGPT sessions.
- Never add cookies, tokens, account details, private browser state, real thread transcripts, unpublished credentials, or local `.codex/` operation data.
- Do not describe the project as affiliated with or endorsed by OpenAI.

## Architecture

- `packages/node/src/bridge/` is the sole runtime authority.
- `bridge.ts` owns the durable submit/collect policy; `browser-port.ts` owns visible UI mechanics; `journal.ts` owns the write-ahead attempt record.
- The repository ships one TypeScript package, one bundle, one plugin, and one generic skill.
- Do not reintroduce Python parity, a child backend, JSON wire contracts, Work, Responses adapters, command registries, review packet builders, locale packs, compatibility façades, or duplicate runtime bundles without a separately justified product requirement.

## Safety and speed

- Preserve exact ChatGPT origin/tab/conversation/turn affinity and at-most-one Send activation.
- Reads may retry. Send, file handoff, and other ambiguous irreversible actions may not silently fall back to a second mechanism.
- Poll metadata only and transfer the full answer once after completion.
- Keep selectors structural and English-specific; let the calling agent or computer use handle unfamiliar UI rather than growing a speculative selector framework.
- Run live browser tests only when the user asks or the change clearly requires them. Redact live content in public reports.

## Local gates

```bash
npm test
npm run build
npm run bundle
npm run plugin:build
npm run plugin:check
npm run plugin:validate
npm run pack:check
```

Do not commit, push, publish, or create a release unless the user explicitly asks after local review.
