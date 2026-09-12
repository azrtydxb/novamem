import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// VitePress builds into `site/docs/` so the existing landing page at
// `site/index.html` and the docs share one Pages artifact. The
// pages.yml workflow uploads `site/` as a whole.
//
// `withMermaid` wraps the config so ```mermaid fenced blocks render
// as live SVG via the official mermaid.js. Without it the blocks fall
// through to plain code-highlighting.
export default withMermaid(
  defineConfig({
    title: "novamem",
    description: "Tiered memory for AI agents — full documentation",
    base: "/novamem/docs/",

    // The pages live in `docs/`, which is the single source: editing a
    // doc in the repo IS editing the site. This package holds only the
    // configuration and the static assets. Nothing under `docs/` may be
    // duplicated back here — `scripts/doc-smoke.mjs` fails if it is.
    srcDir: "../../docs",
    outDir: "../../site/docs",

    // Not every page in `docs/` is published. These are internal working
    // documents — migration specs, parity audits, benchmark write-ups —
    // kept in the repo for contributors, deliberately out of the site's
    // navigation and search.
    srcExclude: [
      "README.md",
      "superpowers/**",
      "architecture/go-parity-audit.md",
      "architecture/mem0-alignment.md",
      "benchmarks/**",
    ],
    cleanUrls: true,
    appearance: "dark",
    lastUpdated: true,

    head: [
      [
        "link",
        { rel: "icon", type: "image/svg+xml", href: "/novamem/favicon.svg" },
      ],
      ["meta", { name: "theme-color", content: "#5b8def" }],
    ],

    themeConfig: {
      siteTitle: "novamem · docs",
      logo: { src: "/favicon.svg", width: 22, height: 22 },

      // Top nav — minimal; the sidebar carries the bulk of navigation.
      nav: [
        // Absolute URL — VitePress would otherwise prepend `base` to a
        // path-style link, turning /novamem/ into /novamem/docs/novamem/.
        // `target: "_self"` + `noIcon: true` undo the external-link
        // styling so the Landing tab feels like part of the same site
        // (which it is — different sub-path of the same Pages deployment).
        {
          text: "Landing",
          link: "https://azrtydxb.github.io/novamem/",
          target: "_self",
          noIcon: true,
        },
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
            { text: "Usage & mental model", link: "/concepts/mental-model" },
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
            {
              text: "Worthiness gate + dedup",
              link: "/architecture/worthiness",
            },
            { text: "Decay & dream cycle", link: "/architecture/decay" },
            { text: "Multi-tenancy", link: "/architecture/multi-tenancy" },
          ],
        },
        {
          text: "API reference",
          collapsed: false,
          items: [
            { text: "Overview", link: "/api/" },
            { text: "Interactive reference", link: "/api/reference" },
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
            {
              text: "Memory recall benchmarks",
              link: "/evaluation-benchmarks",
            },
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
          '<a href="https://github.com/azrtydxb/novamem">github.com/azrtydxb/novamem</a>',
      },

      search: { provider: "local" },

      editLink: {
        pattern: "https://github.com/azrtydxb/novamem/edit/main/docs/:path",
        text: "Edit this page on GitHub",
      },

      outline: { level: [2, 3] },
    },

    markdown: {
      lineNumbers: false,
      theme: { light: "github-light", dark: "github-dark" },
    },

    // The dead-link checker is ON: every internal link now points inside
    // one tree, so a page that moves and leaves a link behind fails the
    // build instead of shipping a 404. Only localhost URLs are exempt —
    // they are install instructions, not links, and nothing is listening
    // on :7778 while the site builds.
    ignoreDeadLinks: [/^https?:\/\/localhost/],

    // Mermaid theme to match the dark palette. Tokens picked from the
    // Grid stylesheet so diagrams blend with the rest of the docs page.
    mermaid: {
      theme: "dark",
    },
  })
);
