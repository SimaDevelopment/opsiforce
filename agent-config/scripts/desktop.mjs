#!/usr/bin/env node
// Pod-local desktop lifecycle and presentation; no credentials leave the pod.
const [command = 'list', ...args] = process.argv.slice(2);
const base = 'http://127.0.0.1:6080';
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.status === 204 ? null : response.json();
}
const usage = 'Usage: desktop list | show [WINDOW_ID]';
if (['--help', '-h', 'help'].includes(command)) {
  console.log(usage);
  process.exit(0);
}
try {
  let result;
  switch (command) {
    case 'list':
      result = await request('/sessions');
      break;
    case 'show':
      result = await request('/sessions/default', 'PATCH', { window: args[0] || '' });
      break;
    default:
      throw new Error(usage);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
