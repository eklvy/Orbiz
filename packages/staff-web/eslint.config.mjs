// Same rules as the dashboards that use this package (React hooks, accessibility, TypeScript).
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Not a Next app itself, so the pages-directory rule doesn't apply.
const config = [
  ...nextVitals,
  ...nextTs,
  { rules: { "@next/next/no-html-link-for-pages": "off" } },
];

export default config;
