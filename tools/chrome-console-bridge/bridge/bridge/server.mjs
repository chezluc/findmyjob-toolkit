import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const HOST = "127.0.0.1";
const PORT = 4471;

// Multi-queue support: each named queue gets its own command list.
// Default queue is "default". Clients specify queue via ?queue=name param.
const queues = new Map(); // name -> []
const results = new Map();

function getQueue(name) {
  const key = name || "default";
  if (!queues.has(key)) queues.set(key, []);
  return queues.get(key);
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload));
}

function notFound(response) {
  json(response, 404, { ok: false, error: "Not found" });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    return notFound(response);
  }

  const url = new URL(request.url, `http://${HOST}:${PORT}`);

  if (request.method === "OPTIONS") {
    return json(response, 204, {});
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const queueSizes = {};
    for (const [name, q] of queues) queueSizes[name] = q.length;
    return json(response, 200, { ok: true, queues: queueSizes, results: results.size });
  }

  if (request.method === "POST" && url.pathname === "/commands") {
    try {
      const body = await readBody(request);
      const command = {
        id: body.id || randomUUID(),
        type: body.type,
        payload: body.payload || {},
        targetTabId: body.targetTabId,
        createdAt: new Date().toISOString()
      };

      if (!["RUN_SNIPPET", "GET_STATE", "GET_AI_STATE", "OPEN_URL"].includes(command.type)) {
        return json(response, 400, { ok: false, error: "Invalid command type" });
      }

      const queueName = url.searchParams.get("queue") || body.queue || "default";
      command.queue = queueName;
      getQueue(queueName).push(command);
      results.set(command.id, { status: "queued", command, queue: queueName });
      return json(response, 202, { ok: true, id: command.id, status: "queued", queue: queueName });
    } catch (error) {
      return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Convenience endpoint for AI state (waits for result)
  if (request.method === "GET" && url.pathname === "/ai-state") {
    const id = randomUUID();
    const targetTabIdStr = url.searchParams.get("targetTabId");
    const targetTabId = targetTabIdStr ? parseInt(targetTabIdStr, 10) : undefined;
    
    const command = { 
      id, 
      type: "GET_AI_STATE", 
      payload: {}, 
      targetTabId,
      createdAt: new Date().toISOString() 
    };
    getQueue("default").push(command);
    results.set(id, { status: "queued", command, queue: "default" });

    // Wait for result
    let attempts = 0;
    while (attempts < 60) {
      const entry = results.get(id);
      if (entry && entry.status === "completed") {
        results.delete(id);
        return json(response, 200, entry.response);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }
    return json(response, 408, { ok: false, error: "Timeout waiting for AI state" });
  }

  if (request.method === "GET" && url.pathname === "/commands/next") {
    const queueName = url.searchParams.get("queue");
    let command = null;
    if (queueName) {
      // Pull from a specific queue
      const q = getQueue(queueName);
      command = q.shift() || null;
    } else {
      // Pull from any queue (round-robin across all queues)
      for (const [, q] of queues) {
        if (q.length > 0) {
          command = q.shift();
          break;
        }
      }
    }
    if (command) {
      results.set(command.id, { ...(results.get(command.id) || {}), status: "running", startedAt: new Date().toISOString(), command });
    }
    return json(response, 200, { ok: true, command });
  }

  if (request.method === "GET" && url.pathname.startsWith("/commands/")) {
    const id = decodeURIComponent(url.pathname.split("/")[2] || "");
    const entry = results.get(id);
    if (!entry) {
      return json(response, 404, { ok: false, error: "Unknown command id" });
    }
    return json(response, 200, { ok: true, ...entry });
  }

  if (request.method === "POST" && url.pathname.endsWith("/result")) {
    const id = decodeURIComponent(url.pathname.split("/")[2] || "");
    try {
      const body = await readBody(request);
      const existing = results.get(id);
      if (!existing) {
        return json(response, 404, { ok: false, error: "Unknown command id" });
      }
      results.set(id, {
        ...existing,
        status: "completed",
        completedAt: new Date().toISOString(),
        response: body
      });
      return json(response, 200, { ok: true });
    } catch (error) {
      return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return notFound(response);
});

server.listen(PORT, HOST, () => {
  console.log(`Chrome Console Bridge server listening on http://${HOST}:${PORT}`);
});
