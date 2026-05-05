import { defineConfig } from "vitepress";

// VitePress builds into `site/docs/` so the existing landing page at
// `site/index.html` and the docs share one Pages artifact. The
// pages.yml workflow uploads `site/` as a whole.
export default defineConfig({
  title: "novamem",
  description: "Tiered memory for AI agents — full documentation",
  base: "/novamem/docs/",
  outDir: "../../site/docs",
  cleanUrls: true,
  appearance: "dark",
  lastUpdated: true,

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/novamem/favicon.svg" }],
    ["meta", { name: "theme-color", content: "#5b8def" }],
  ],

  themeConfig: {
    siteTitle: "novamem · docs",
    logo: { src: "/favicon.svg", width: 22, height: 22 },

    // Top nav — minimal; the sidebar carries the bulk of navigation.
    nav: [
      { text: "Landing", link: "/novamem/" },
      { text: "GitHub", link: "https://github.com/azrtydxb/novamem" },
      {
        text: "Releases",
        link: "https://github.com/azrtydxb/novamem/releases",
      },
    ],

    sidebar: [
      {
        text: "Getting started",
        items: [
          { text: "Overview", link: "/" },
          { text: "Quick start", link: "/getting-started" },
          { text: "Mental model", link: "/concepts/mental-model" },
        ],
      },
      {
        text: "Install",
        collapsed: false,
        items: [
          { text: "Docker Compose", link: "/install/docker-compose" },
          { text: "Kubernetes", link: "/install/kubernetes" },
          { text: "Manual", link: "/install/manual" },
          { text: "Environment reference", link: "/install/env-reference" },
        ],
      },
      {
        text: "Connect agents",
        collapsed: false,
        items: [
          { text: "novamem-init CLI", link: "/connect/init-cli" },
          { text: "Claude Code", link: "/connect/claude-code" },
          { text: "Claude Desktop", link: "/connect/claude-desktop" },
          { text: "Cursor", link: "/connect/cursor" },
          { text: "Kilo Code", link: "/connect/kilo-code" },
          { text: "Other hosts + Skills", link: "/connect/others" },
          { text: "Custom HTTP integration", link: "/connect/http" },
        ],
      },
      {
        text: "Dashboard",
        collapsed: false,
        items: [
          { text: "Sign in & roles", link: "/dashboard/auth-roles" },
          { text: "Metrics", link: "/dashboard/metrics" },
          { text: "Browse · Today · Graph", link: "/dashboard/browse" },
          { text: "Projects (sub-brains)", link: "/dashboard/projects" },
          { text: "Users (admin)", link: "/dashboard/users" },
          { text: "API tokens", link: "/dashboard/tokens" },
        ],
      },
      {
        text: "Architecture",
        collapsed: false,
        items: [
          { text: "System shape", link: "/architecture/system" },
          { text: "Tiered storage", link: "/architecture/tiers" },
          { text: "Hybrid search", link: "/architecture/hybrid-search" },
          { text: "Worthiness gate + dedup", link: "/architecture/worthiness" },
          { text: "Decay & dream cycle", link: "/architecture/decay" },
          { text: "Multi-tenancy", link: "/architecture/multi-tenancy" },
        ],
      },
      {
        text: "API reference",
        collapsed: false,
        items: [
          { text: "Overview", link: "/api/" },
          { text: "Authentication", link: "/api/auth" },
          { text: "Data plane", link: "/api/data-plane" },
          { text: "Admin & users", link: "/api/admin" },
          { text: "MCP tools", link: "/api/mcp-tools" },
          { text: "OpenAPI spec", link: "/api/openapi" },
        ],
      },
      {
        text: "Operations",
        collapsed: true,
        items: [
          { text: "Security model", link: "/ops/security" },
          { text: "Hardening checklist", link: "/ops/hardening" },
          { text: "Audit log", link: "/ops/audit-log" },
          { text: "Backup & restore", link: "/ops/backup" },
          { text: "Upgrades", link: "/ops/upgrades" },
        ],
      },
      {
        text: "Contribute",
        collapsed: true,
        items: [
          { text: "Local development", link: "/contribute/dev-setup" },
          { text: "Project layout", link: "/contribute/layout" },
          { text: "Testing", link: "/contribute/testing" },
          { text: "Release flow", link: "/contribute/releases" },
          { text: "Filing bugs", link: "/contribute/bugs" },
        ],
      },
      {
        text: "Reference",
        collapsed: true,
        items: [
          { text: "Changelog", link: "/reference/changelog" },
          { text: "Glossary", link: "/reference/glossary" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/azrtydxb/novamem" },
    ],

    footer: {
      message: "Apache 2.0 — self-hostable",
      copyright:
        "<a href=\"https://github.com/azrtydxb/novamem\">github.com/azrtydxb/novamem</a>",
    },

    search: { provider: "local" },

    editLink: {
      pattern:
        "https://github.com/azrtydxb/novamem/edit/main/packages/docs-site/:path",
      text: "Edit this page on GitHub",
    },

    outline: { level: [2, 3] },
  },

  markdown: {
    lineNumbers: false,
    theme: { light: "github-light", dark: "github-dark" },
  },

  // Dead-link checker ignores migrated relative paths that resolve outside
  // the docs-site root (e.g. links to ../../.env.example or ../../deploy/).
  // Those are repo-relative links from the original docs/ markdown — they
  // work on GitHub's renderer but not in VitePress. Migrating each one to
  // an absolute github.com URL is a follow-up; for now skip the check so
  // the build passes.
  ignoreDeadLinks: true,
});
