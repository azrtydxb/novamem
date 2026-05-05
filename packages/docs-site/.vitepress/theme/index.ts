// Custom theme — extend VitePress default and override CSS variables to
// match the Grid palette used by the landing page and admin dashboard.
import DefaultTheme from "vitepress/theme";
import "./grid-palette.css";

export default {
  extends: DefaultTheme,
};
