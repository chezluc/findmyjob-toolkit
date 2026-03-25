export function slugify(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function callBridge(message, { baseUrl = 'http://127.0.0.1:4471', timeoutMs = 15000 } = {}) {
  const submitResponse = await fetch(`${baseUrl}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: `toolkit_${Date.now()}`,
      ...message,
    }),
  });

  if (!submitResponse.ok) {
    throw new Error(`Bridge submit failed with HTTP ${submitResponse.status}`);
  }

  const submitted = await submitResponse.json();
  const commandId = submitted.id;
  if (!commandId) {
    throw new Error('Bridge did not return a command id');
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollResponse = await fetch(`${baseUrl}/commands/${encodeURIComponent(commandId)}`);
    if (!pollResponse.ok) {
      throw new Error(`Bridge poll failed with HTTP ${pollResponse.status}`);
    }
    const polled = await pollResponse.json();
    if (polled.status === 'completed') return polled.response;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Bridge timeout after ${timeoutMs}ms for message type ${message.type}`);
}
