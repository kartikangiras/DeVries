// MCP servers shown on the landing page, with their marks from simple-icons (CC0-1.0). The marquee
// says what Cistern can load: any server a client config names, and the tools it lists. Brands
// whose mark is black are drawn in ink so they read on a dark surface.

import {
  siAirtable, siAsana, siBrave, siClaude, siCloudflare, siCursor, siDatadog, siDiscord, siDocker, siFigma,
  siGithub, siGmail, siGooglecalendar, siGoogledrive, siGrafana, siHubspot, siIntercom, siJira, siKubernetes,
  siLinear, siMongodb, siNotion, siObsidian, siPostgresql, siRedis, siSentry, siSqlite, siStripe, siSupabase,
  siZendesk, type SimpleIcon,
} from "simple-icons";

export type Server = { id: string; name: string; icon: SimpleIcon; ink?: boolean };

export const SERVERS: Server[] = [
  { id: "github", name: "GitHub", icon: siGithub, ink: true },
  { id: "linear", name: "Linear", icon: siLinear },
  { id: "notion", name: "Notion", icon: siNotion, ink: true },
  { id: "stripe", name: "Stripe", icon: siStripe },
  { id: "postgresql", name: "PostgreSQL", icon: siPostgresql },
  { id: "sentry", name: "Sentry", icon: siSentry, ink: true },
  { id: "figma", name: "Figma", icon: siFigma },
  { id: "googledrive", name: "Google Drive", icon: siGoogledrive },
  { id: "gmail", name: "Gmail", icon: siGmail },
  { id: "jira", name: "Jira", icon: siJira },
  { id: "zendesk", name: "Zendesk", icon: siZendesk, ink: true },
  { id: "cloudflare", name: "Cloudflare", icon: siCloudflare },
  { id: "supabase", name: "Supabase", icon: siSupabase },
  { id: "docker", name: "Docker", icon: siDocker },
  { id: "claude", name: "Claude", icon: siClaude },
  { id: "cursor", name: "Cursor", icon: siCursor, ink: true },
  { id: "hubspot", name: "HubSpot", icon: siHubspot },
  { id: "mongodb", name: "MongoDB", icon: siMongodb },
  { id: "redis", name: "Redis", icon: siRedis },
  { id: "airtable", name: "Airtable", icon: siAirtable },
  { id: "asana", name: "Asana", icon: siAsana },
  { id: "discord", name: "Discord", icon: siDiscord },
  { id: "intercom", name: "Intercom", icon: siIntercom },
  { id: "sqlite", name: "SQLite", icon: siSqlite, ink: true },
  { id: "googlecalendar", name: "Google Calendar", icon: siGooglecalendar },
  { id: "obsidian", name: "Obsidian", icon: siObsidian },
  { id: "grafana", name: "Grafana", icon: siGrafana },
  { id: "datadog", name: "Datadog", icon: siDatadog },
  { id: "kubernetes", name: "Kubernetes", icon: siKubernetes },
  { id: "brave", name: "Brave Search", icon: siBrave },
];

export const byId: Record<string, Server> = Object.fromEntries(SERVERS.map((s) => [s.id, s]));

/** The marquee, in an order that spreads the colours out. */
export const MARQUEE = [
  "github", "stripe", "notion", "postgresql", "linear", "gmail", "cloudflare", "supabase", "jira", "claude",
  "figma", "redis", "zendesk", "docker", "sentry", "googledrive", "hubspot", "cursor", "mongodb", "airtable",
  "discord", "grafana", "sqlite", "intercom", "asana", "kubernetes", "obsidian", "datadog", "googlecalendar", "brave",
];
