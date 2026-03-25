# Setup

This repo works when:

1. The local bridge server is running.
2. The Chrome extension is loaded.
3. The extension’s `bridge.html` tab is open (the poller).

## 1. Build The Chrome Extension

```bash
cd tools/chrome-console-bridge
npm install
npm run build
```

In Chrome:

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `tools/chrome-console-bridge/dist`

## 2. Start The Local Bridge Server

```bash
cd tools/chrome-console-bridge
node bridge/server.mjs
```

Health check:

```bash
curl http://127.0.0.1:4471/health
```

## 3. Open The Bridge Tab

After loading the extension, open:

```text
chrome-extension://<EXTENSION_ID>/bridge.html
```

Keep this tab open. It polls the server and executes queued commands.

## 4. Smoke Test

Open any normal webpage in another tab, then run:

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

Poll the result:

```bash
curl http://127.0.0.1:4471/commands/<COMMAND_ID>
```

## 5. Generate Title Queries

```bash
node scripts/discover-jobs.mjs --title "production designer"
```
