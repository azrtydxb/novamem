// Custom theme — extend VitePress default and override CSS variables to
// match the Grid palette used by the landing page and admin dashboard.
import { defineAsyncComponent } from "vue";
import DefaultTheme from "vitepress/theme";
import "./grid-palette.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: { component: (n: string, c: unknown) => void } }) {
    // Used by docs/api/reference.md, which is a full-width page whose
    // whole content is the rendered OpenAPI document.
    //
    // Async on purpose: a static import puts the renderer and the whole
    // OpenAPI document into the theme chunk, which every page of the site
    // loads. One page needs it, so one page pays for it.
    app.component(
      "ApiReference",
      defineAsyncComponent(() => import("./ApiReference.vue"))
    );
  },
};
