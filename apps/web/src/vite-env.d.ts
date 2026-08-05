/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the API origin. Unset in normal prod builds -- see api.ts. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
