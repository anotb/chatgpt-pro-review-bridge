# Upstream history

This repository originated from `adamallcock/codex-chatgpt-control` and intentionally diverged into a smaller product.

The current architecture is not a compatibility fork: it removes the backend, command framework, Work/Responses surfaces, Python parity client, contracts, locales, and duplicate plugins. Upstream selector or visible-session fixes may still be useful, but import the narrow behavior and tests—not the deleted framework around it.

Before taking an upstream change, verify that it preserves:

- exact visible `chatgpt.com` origin, tab, conversation, and turn ownership;
- a durable attempt record before one Send activation;
- non-submitting collection;
- assistant-turn-scoped output and artifacts;
- the one-package, one-bundle, one-plugin boundary.
