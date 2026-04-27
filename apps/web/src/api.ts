/**
 * Browser-side session storage helpers. Pure plumbing — the actual API surface
 * lives in `@agentd/client` (`AgentdClient`) and the React-Query bindings live
 * in `./queries.ts`.
 */

const TOKEN_KEY = "agentd.token";
const SERVER_KEY = "agentd.server";

export function loadStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function loadStoredServer(): string {
  return localStorage.getItem(SERVER_KEY) ?? location.origin;
}

export function saveSession(server: string, token: string): void {
  localStorage.setItem(SERVER_KEY, server);
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
}
