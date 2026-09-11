<!--
  The interactive API reference, rendered from the checked-in OpenAPI
  document.

  Why a component rather than the CDN <script> Scalar documents: on a
  VitePress page that script mounts into the body before hydration, and
  hydration then replaces the content — the page builds fine and renders
  blank, which is exactly the failure mode a docs site cannot afford.
  Mounting inside the page's own lifecycle puts the reference under
  VitePress's control instead of racing it.

  The spec is imported, not fetched: it ships in the bundle, so the page
  has no runtime dependency on GitHub being up or on CORS, and a spec
  that fails to parse breaks the build instead of the page. The version
  of @scalar/api-reference here is pinned to the one the server embeds
  for its own /api-docs — scripts/doc-smoke.mjs fails if they drift, so
  a reader gets the same renderer on either surface.
-->
<script setup>
import { ApiReference } from "@scalar/api-reference";
import "@scalar/api-reference/style.css";
import spec from "../../../../docs/api/openapi.json";

const configuration = {
  content: spec,
  theme: "deepSpace",
  darkMode: true,
  hideDownloadButton: false,
  // No `servers` override. Naming a placeholder host here would aim the
  // "Test Request" button at a domain reserved by RFC 2606 that answers
  // nothing, so the first thing a reader tried would fail for a reason
  // that has nothing to do with novamem. The spec's own servers stand,
  // and a reader who wants to fire real requests has /api-docs on their
  // deployment, which is pointed at itself.
};
</script>

<template>
  <ClientOnly>
    <ApiReference :configuration="configuration" />
  </ClientOnly>
</template>

<style scoped>
/* The reference owns the full width; VitePress's page padding would
   otherwise squeeze a three-column layout into a column. */
:deep(.scalar-app) {
  --scalar-font: var(--vp-font-family-base);
}
</style>
