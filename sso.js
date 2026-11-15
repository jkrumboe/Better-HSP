// sso.js
// Uni-SSO (SAML/Shibboleth) über das delcom-Backend.
//
// Ablauf (wie im offiziellen HSP-Frontend):
//   1. Browser -> {API}/saml/discovery-callback?callbackUrl={unsere Callback-URL}&entityId={IdP}
//   2. Nutzer meldet sich beim Uni-IdP an (Shibboleth) – wir sehen das Passwort NIE.
//   3. delcom leitet zurück auf unsere Callback-URL mit ?tokenReponse=<base64>
//      (Tippfehler "tokenReponse" stammt aus dem delcom-Frontend – bewusst so belassen).
//   4. base64 -> JSON { access_token, refresh_token, id_token, expires_in, scope, token_type }
//
// Hinweis: Ob delcom eine fremde callbackUrl akzeptiert, ist nicht garantiert. Falls der
// Redirect scheitert, bleibt das Einfügen der delcom_auth-Daten als Fallback bestehen.

const API_BASE = 'https://backbone-web-api.production.munster.delcom.nl';

// Angeboten laut HSP-Frontend (samlProviderSettings).
export const SSO_PROVIDERS = [
  { id: 'uni-ms', name: 'Uni Münster (Uni Kennung)', entityId: 'https://zividp.uni-muenster.de/idp/shibboleth' },
  { id: 'fh-ms', name: 'FH Münster (FH Kennung)', entityId: 'https://idp.fh-muenster.de/idp/shibboleth' },
  { id: 'katho', name: 'Katho NRW', entityId: 'https://shibboleth-idp.katho-nrw.de/idp/shibboleth' },
  { id: 'ka-ms', name: 'Kunstakademie Münster (KA Kennung)', entityId: 'https://idpka.uni-muenster.de/idp/shibboleth' }
];

export function getProvider(id) {
  return SSO_PROVIDERS.find(p => p.id === id) || null;
}

/**
 * Baut die Redirect-URL zum delcom-SAML-Discovery-Endpoint.
 */
export function buildSsoRedirect(entityId, callbackUrl) {
  const params = new URLSearchParams({ callbackUrl, entityId });
  return `${API_BASE}/saml/discovery-callback?${params.toString()}`;
}

/**
 * Dekodiert den von delcom zurückgegebenen tokenReponse-Parameter.
 * Gibt { accessToken, refreshToken, idToken, expiresIn, scope, tokenType } zurück.
 */
export function parseTokenResponse(tokenReponseB64) {
  if (!tokenReponseB64) throw new Error('Kein tokenReponse empfangen');
  const json = JSON.parse(Buffer.from(String(tokenReponseB64), 'base64').toString('utf8'));
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    expiresIn: json.expires_in,
    scope: json.scope,
    tokenType: json.token_type
  };
}
