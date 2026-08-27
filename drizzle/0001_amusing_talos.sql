CREATE INDEX `idx_likes_user_id` ON `likes` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_likes_post_id` ON `likes` (`post_id`);--> statement-breakpoint
CREATE INDEX `idx_posts_created_at` ON `posts` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_posts_user_id` ON `posts` (`user_id`);