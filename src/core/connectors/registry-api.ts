// Fetches pages of servers from the public MCP registry. The registry pages
// with a cursor, and an empty query pages through every server it lists.

import type { FetchFunction } from '../sync/github.js';

import { parseRegistry, type RegistryPage } from './registry.js';

export const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
export const REGISTRY_LIMIT = 50;
const REGISTRY_TIMEOUT_MS = 15_000;

export function registryUrl(query: string, cursor: string | null = null): string {
  const params = new URLSearchParams({ limit: String(REGISTRY_LIMIT), version: 'latest' });
  if (query.trim() !== '') {
    params.set('search', query.trim());
  }
  if (cursor !== null) {
    params.set('cursor', cursor);
  }
  return `${REGISTRY_URL}?${params.toString()}`;
}

/**
 * One page of servers whose name matches the query, from the cursor on. An
 * empty query pages through the whole registry.
 */
export async function searchRegistry(
  fetchFunction: FetchFunction,
  query: string,
  cursor: string | null = null,
): Promise<RegistryPage> {
  const response = await fetchFunction(registryUrl(query, cursor), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The MCP registry answered ${String(response.status)}.`);
  }
  return parseRegistry(await response.json());
}
