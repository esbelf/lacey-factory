/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_AUTH?: string;
  readonly VITE_AUTH0_DOMAIN?: string;
  readonly VITE_AUTH0_CLIENT_ID?: string;
  readonly VITE_AUTH0_AUDIENCE?: string;
}
