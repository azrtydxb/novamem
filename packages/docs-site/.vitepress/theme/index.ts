// Custom theme — extend VitePress default and override CSS variables to
// match the Grid palette used by the landing page and admin dashboard.
import DefaultTheme from "vitepress/theme";
import "./grid-palette.css";
import ApiReference from "./ApiReference.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: { component: (n: string, c: unknown) => void } }) {
    // Used by docs/api/reference.md, which is a full-width page whose
    // whole content is the rendered OpenAPI document.
    app.component("ApiReference", ApiReference);
  },
};
