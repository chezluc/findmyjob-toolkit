# General Chrome Console Bridge Startup

This version is bridge-tab only. It does not use a popup or side panel.

## Session checklist

1. Start the local bridge server:
   ```bash
   cd tools/chrome-console-bridge
   npm run bridge
   ```
   If port `4471` is already in use, reuse the running server.

2. Build the extension when source changes:
   ```bash
   cd tools/chrome-console-bridge
   npm install
   npm run build
   ```

3. In Chrome, load the unpacked extension from:
   ```text
   tools/chrome-console-bridge/dist
   ```

4. Open the bridge tab:
   ```text
   chrome-extension://<EXTENSION_ID>/bridge.html
   ```
   Keep that tab open. It is the poller that connects the extension to `http://127.0.0.1:4471`.

5. Open or focus the target webpage in another tab.

6. Smoke test the bridge:
   ```bash
   curl -X POST http://127.0.0.1:4471/commands \
     -H 'Content-Type: application/json' \
     -d '{
       "type": "RUN_SNIPPET",
       "payload": {
         "code": "return { title: document.title, url: location.href }",
         "world": "MAIN",
         "snippetName": "smoke test"
       }
     }'
   ```
   Then poll:
   ```bash
   curl http://127.0.0.1:4471/commands/<COMMAND_ID>
   ```

## Operational notes

- Prefer `RUN_SNIPPET` as the main execution path.
- Include `targetTabId` when you need to lock execution to a specific tab.
- The bridge tab is internal. It is not the target page.
- Do not open DevTools on a controlled tab while the debugger is attached.
