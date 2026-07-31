const SUPPORTED_OAUTH_AUDIENCES = new Set(["openfront.io", "openfront.dev"]);

/**
 * Return the public web origin accepted by the selected OpenFront auth
 * service. The API callback remains on api.<audience>; this URI is the
 * post-login destination stored by the auth service.
 */
export function getOAuthRedirectUri(audience: string): string | null {
  const normalizedAudience = audience.trim().toLowerCase();
  if (!SUPPORTED_OAUTH_AUDIENCES.has(normalizedAudience)) {
    return null;
  }
  return `https://${normalizedAudience}/`;
}
