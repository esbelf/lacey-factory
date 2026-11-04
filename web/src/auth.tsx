import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { type ReactNode, useEffect } from "react";
import { useNavigate } from "react-router";

import { DEV_AUTH, setTokenGetter } from "./api";
import { Denied, Splash } from "./components/splash";

/**
 * The whole app sits behind Auth0. Signed-out visitors are sent straight to
 * the Auth0 login page. With VITE_DEV_AUTH=true (local only) Auth0 is skipped
 * and the API's DEV_AUTH_EMAIL decides who you are.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  if (DEV_AUTH) return <>{children}</>;

  const { VITE_AUTH0_DOMAIN: domain, VITE_AUTH0_CLIENT_ID: clientId, VITE_AUTH0_AUDIENCE: audience } = import.meta.env;
  if (!domain || !clientId || !audience) {
    return <Splash>Auth0 isn&apos;t configured (VITE_AUTH0_DOMAIN / CLIENT_ID / AUDIENCE).</Splash>;
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{ redirect_uri: window.location.origin, audience, scope: "openid profile email offline_access" }}
      // Keeps floor tablets signed in across reloads without third-party cookies.
      useRefreshTokens
      cacheLocation="localstorage"
      onRedirectCallback={(appState) => navigate(appState?.returnTo ?? "/rolls", { replace: true })}
    >
      <RequireLogin>{children}</RequireLogin>
    </Auth0Provider>
  );
}

function RequireLogin({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, error, loginWithRedirect, getAccessTokenSilently } = useAuth0();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !error) {
      loginWithRedirect({ appState: { returnTo: window.location.pathname + window.location.search } });
    }
  }, [isLoading, isAuthenticated, error, loginWithRedirect]);

  if (error) return <Denied message={error.message} />;
  if (isLoading || !isAuthenticated) return <Splash>Signing in…</Splash>;

  setTokenGetter(() => getAccessTokenSilently());
  return <>{children}</>;
}

/** Log out of Auth0 (no-op under dev auth). */
export function useLogout(): (() => void) | undefined {
  if (DEV_AUTH) return undefined;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- DEV_AUTH is a build-time constant
  const { logout } = useAuth0();
  return () => logout({ logoutParams: { returnTo: window.location.origin } });
}
