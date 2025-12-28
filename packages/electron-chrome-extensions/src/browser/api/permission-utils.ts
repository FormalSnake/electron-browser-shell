import { matchesPattern } from './common'

/**
 * Checks if a string is a host permission pattern.
 * Host patterns contain :// or are special patterns like <all_urls>
 */
function isHostPattern(permission: string): boolean {
  return permission === '<all_urls>' || permission.includes('://') || permission.startsWith('*.')
}

/**
 * Checks if an extension has host access to a URL via host_permissions.
 *
 * @param manifest The extension's manifest
 * @param url The URL to check access for
 * @returns true if the extension has permission to access the URL
 */
export function hasHostPermission(manifest: chrome.runtime.Manifest, url: string): boolean {
  const hostPermissions = [
    ...(manifest.host_permissions || []),
    // MV2 used permissions array for host patterns
    ...((manifest.permissions?.filter((p) => isHostPattern(p)) as string[]) || []),
  ]

  if (hostPermissions.length === 0) return false
  return hostPermissions.some((pattern) => matchesPattern(pattern, url))
}

/**
 * Throws if extension lacks host permission for URL.
 *
 * @param manifest The extension's manifest
 * @param url The URL to check access for
 * @param apiName The API name for the error message
 */
export function requireHostPermission(
  manifest: chrome.runtime.Manifest,
  url: string,
  apiName: string,
): void {
  if (!hasHostPermission(manifest, url)) {
    throw new Error(`${apiName} requires host permission for ${new URL(url).origin}`)
  }
}
