# Plugin privacy

The ChatGPT Bridge plugin operates a visible, user-controlled ChatGPT web session. It has no hosted service and does not read cookies, tokens, browser profiles, hidden storage, or private ChatGPT endpoints.

The prompt and explicit files selected by the calling task are sent through visible ChatGPT controls. The user should not submit secrets or sensitive material without intentionally approving that disclosure.

Local `.codex/chatgpt-bridge/` operation data is private and ignored by Git. Durable records contain hashes, counts, selection labels, timestamps, and tab/thread affinity—not prompt text, response text, filenames, file paths, account identifiers, cookies, or credentials. Downloaded outputs may contain the model response and remain local unless the user chooses to share them.
