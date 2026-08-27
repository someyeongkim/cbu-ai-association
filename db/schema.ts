import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const posts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.userId),
  description: text("description").notNull(),
  imageKey: text("image_key").notNull().unique(),
  contentType: text("content_type").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("idx_posts_created_at").on(table.createdAt),
  index("idx_posts_user_id").on(table.userId),
]);

export const likes = sqliteTable("likes", {
  id: text("id").primaryKey(),
  postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_likes_post_user").on(table.postId, table.userId),
  index("idx_likes_user_id").on(table.userId),
  index("idx_likes_post_id").on(table.postId),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
});

export const likeLimits = sqliteTable("like_limits", {
  userId: text("user_id").primaryKey().references(() => users.userId, { onDelete: "cascade" }),
  limitCount: integer("limit_count").notNull(),
});