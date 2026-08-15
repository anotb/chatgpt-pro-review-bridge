# Safety boundary

This project automates only a user-visible ChatGPT web session exposed by a compatible browser host.

It must not:

- read cookies, tokens, hidden auth state, browser profiles, or private endpoints;
- guess among tabs, conversations, model labels, tools, files, or response artifacts;
- retry Send or fall back from a failed Send click to Enter;
- attach files not explicitly supplied by the caller;
- accept login, captcha, permission, rate-limit, modal, or fallback states as success;
- read or download output from a turn not owned by the operation.

The operation journal stores prompt/request hashes, counts, timestamps, selection labels, and tab/thread binding. It excludes prompt and response text, file names and paths, account identifiers, and browser credentials.

Generated output is untrusted. The bridge returns it; the calling agent decides whether to execute code, apply patches, publish content, or take an external action.

Strict duplicate prevention trades availability for safety: a crash after the write-ahead attempt but before file completion or Send may leave an `uncertain` operation. Reusing that operation ID or collecting its handle cannot Send again; never delete/reset the record merely to try again.
