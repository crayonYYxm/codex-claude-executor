Implement a small behavior change in this workspace.

Requirements:
- Add a new exported function `formatGreeting(name, role)` in `src/greetings.js`.
- `name` should be trimmed before reuse.
- If `role` is empty after trimming, default it to `"member"`.
- The return value must be `${greet(name)} You're logged in as ${role}.`
- Preserve the existing `greet` export and behavior.
- Update `test/greetings.node-test.js` to cover the new function.
- Run `npm test`.

Keep the implementation focused on this task only.
