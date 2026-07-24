import { pgTable, serial, text, boolean, timestamp, integer, jsonb, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

// ── Better Auth tables ───────────────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

// ── OIDC Provider tables (for MCP OAuth) ─────────────────────────────────────

export const oauthApplication = pgTable("oauth_application", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull().default("web"),
  disabled: boolean("disabled").notNull().default(false),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  accessToken: text("access_token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "date" }).notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: "date" }).notNull(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  consentGiven: boolean("consent_given").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// ── Application tables ──────────────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  personal: boolean("personal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable("organization_members", {
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }).notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.userId] }),
  index("idx_organization_members_user").on(table.userId),
]);

export const organizationInvitations = pgTable("organization_invitations", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deliveryError: text("delivery_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("organization_invitations_org_email_unique").on(table.organizationId, table.email),
  index("idx_organization_invitations_email").on(table.email),
  index("idx_organization_invitations_org_expiry").on(table.organizationId, table.expiresAt),
]);

export const ORGANIZATION_ROLES = ["member", "admin"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const collections = pgTable("collections", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  schema: jsonb("schema").default({ fields: [] }),
  uniqueKey: jsonb("unique_key").default([]),
  published: boolean("published").default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  visibility: text("visibility").notNull().default("private"),
  orgDefaultRole: text("org_default_role").notNull().default("viewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_collections_org_name").on(table.organizationId, table.name),
  index("idx_collections_organization").on(table.organizationId),
]);

export const collectionMembers = pgTable("collection_members", {
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }).notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.collectionId, table.userId] }),
  index("idx_collection_members_user").on(table.userId),
]);

export const collectionInvitations = pgTable("collection_invitations", {
  id: text("id").primaryKey(),
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "cascade" }).notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deliveryError: text("delivery_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("collection_invitations_collection_email_unique").on(table.collectionId, table.email),
  index("idx_collection_invitations_email").on(table.email),
]);

// All roles are stored in `collection_members.role`. A collection has exactly
// one row with role='owner' (enforced by a partial unique index from
// drizzle/0013_collection_members_owner_role.sql). `INVITABLE_ROLES` is the
// subset granted via the invitation flow — owners are set at creation or via
// explicit transfer, not invited.
export const COLLECTION_ROLES = ["viewer", "editor", "owner"] as const;
export type CollectionRole = (typeof COLLECTION_ROLES)[number];
export const INVITABLE_ROLES = ["viewer", "editor"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const records = pgTable("records", {
  id: serial("id").primaryKey(),
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "cascade" }).notNull(),
  data: jsonb("data").notNull(),
  source: text("source"),
  status: text("status").default("active"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("idx_records_collection_created").on(table.collectionId, table.createdAt),
  index("idx_records_data_gin").using("gin", table.data),
]);

// ── MCP OAuth tables (custom CIMD OAuth 2.1) ─────────────────────────────────

export const mcpAccessTokens = pgTable("mcp_access_tokens", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: text("client_id").notNull(),
  scope: text("scope").notNull().default("mcp"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const mcpRefreshTokens = pgTable("mcp_refresh_tokens", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: text("client_id").notNull(),
  scope: text("scope").notNull().default("mcp"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: jsonb("redirect_uris").notNull().$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpOauthSessions = pgTable("mcp_oauth_sessions", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name"),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  state: text("state"),
  scope: text("scope").notNull().default("mcp"),
  type: text("type").notNull().$type<"session" | "auth_code">(),
  userId: text("user_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Views ─────────────────────────────────────────────────────────────────────

export const views = pgTable("views", {
  id: serial("id").primaryKey(),
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  type: text("type").default("table"),
  filter: jsonb("filter").default({}),
  sort: text("sort"),
  columns: jsonb("columns").default([]),
  config: jsonb("config").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_views_collection_slug").on(table.collectionId, table.slug),
]);
