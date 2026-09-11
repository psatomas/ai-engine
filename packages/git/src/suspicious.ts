/** Paths that deserve extra human scrutiny whenever an agent touches them. */
export const SUSPICIOUS_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)id_rsa(\.pub)?$/,
  /(^|\/)\.ssh\//,
  /(^|\/)credentials(\.json|\.yaml|\.yml)?$/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.git\/hooks\//,
  /(^|\/)Dockerfile$/,
  /(^|\/)docker-compose\.ya?ml$/
];

export function isSuspiciousPath(path: string): boolean {
  return SUSPICIOUS_PATH_PATTERNS.some((p) => p.test(path));
}
