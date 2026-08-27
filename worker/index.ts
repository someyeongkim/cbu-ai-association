/** Cloudflare Worker entry point for the CBU AI Association site. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import siteHtml from "../public/site.html?raw";

const ADMIN_EMAIL = "somyeong.1024@gmail.com";
const DEFAULT_LIKE_LIMIT = 10;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Viewer = {
  userId: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function safeName(request: Request, email: string): string {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  if (encoded && encoding === "percent-encoded-utf-8") {
    try {
      const decoded = decodeURIComponent(encoded).trim();
      if (decoded) return decoded.slice(0, 100);
    } catch {
      // Fall through to the email-derived display name.
    }
  }
  return email.split("@")[0].slice(0, 100);
}

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), description TEXT NOT NULL, image_key TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS likes (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_post_user ON likes(post_id, user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_likes_user_id ON likes(user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS like_limits (user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE, limit_count INTEGER NOT NULL)"),
    db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES ('default_like_limit', 10)"),
    db.prepare("PRAGMA optimize"),
  ]);
}

async function getViewer(request: Request, db: D1Database): Promise<Viewer | null> {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
  if (!userId || !email) return null;
  const displayName = safeName(request, email);
  await db.prepare(
    "INSERT INTO users(user_id, email, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name",
  ).bind(userId, email, displayName, Date.now()).run();
  return { userId, email, displayName, isAdmin: email === ADMIN_EMAIL };
}

async function getLikeSummary(db: D1Database, userId: string) {
  const row = await db.prepare(
    `SELECT
      COALESCE((SELECT limit_count FROM like_limits WHERE user_id = ?), (SELECT value FROM settings WHERE key = 'default_like_limit'), ?) AS like_limit,
      (SELECT COUNT(*) FROM likes WHERE user_id = ?) AS likes_given,
      (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.user_id = ?) AS likes_received`,
  ).bind(userId, DEFAULT_LIKE_LIMIT, userId, userId).first<{ like_limit: number; likes_given: number; likes_received: number }>();
  const limit = Number(row?.like_limit ?? DEFAULT_LIKE_LIMIT);
  const given = Number(row?.likes_given ?? 0);
  return { likeLimit: limit, likesGiven: given, likesRemaining: Math.max(0, limit - given), likesReceived: Number(row?.likes_received ?? 0) };
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const viewer = await getViewer(request, env.DB);
  if (!viewer) return json({ authenticated: false, signInUrl: "/signin-with-chatgpt?return_to=%2F%23community" });
  const summary = await getLikeSummary(env.DB, viewer.userId);
  return json({ authenticated: true, ...viewer, ...summary, signOutUrl: "/signout-with-chatgpt?return_to=%2F" });
}

async function handlePosts(request: Request, env: Env): Promise<Response> {
  const viewer = await getViewer(request, env.DB);
  if (request.method === "GET") {
    const viewerId = viewer?.userId ?? "";
    const result = await env.DB.prepare(
      `SELECT p.id, p.user_id AS author_id, p.description, p.created_at, u.display_name,
        CASE WHEN EXISTS (SELECT 1 FROM likes mine WHERE mine.post_id = p.id AND mine.user_id = ?) THEN 1 ELSE 0 END AS viewer_liked,
        CASE WHEN p.user_id = ? OR ? = 1 THEN (SELECT COUNT(*) FROM likes total WHERE total.post_id = p.id) ELSE NULL END AS like_count
       FROM posts p JOIN users u ON u.user_id = p.user_id
       ORDER BY p.created_at DESC LIMIT 100`,
    ).bind(viewerId, viewerId, viewer?.isAdmin ? 1 : 0).all();
    return json({ posts: result.results.map((row) => ({
      id: row.id,
      authorName: row.display_name,
      description: row.description,
      createdAt: row.created_at,
      imageUrl: `/media/${row.id}`,
      isOwn: Boolean(viewer && row.author_id === viewer.userId),
      viewerLiked: Boolean(row.viewer_liked),
      likeCount: row.like_count === null ? null : Number(row.like_count),
    })) });
  }

  if (request.method !== "POST") return error("M筌?툓odo no permitido.", 405);
  if (!viewer) return error("Inicia sesi筌ｌ겖 para publicar.", 401);
  const form = await request.formData();
  const description = String(form.get("description") ?? "").trim();
  const image = form.get("image");
  if (!description || description.length > 1000) return error("Escribe una descripci筌ｌ겖 de 1 a 1000 caracteres.");
  if (!(image instanceof File) || image.size === 0) return error("Selecciona una foto.");
  if (image.size > MAX_IMAGE_BYTES) return error("La foto debe pesar 8 MB o menos.");
  if (!ALLOWED_IMAGE_TYPES.has(image.type)) return error("Usa una imagen JPG, PNG, WebP o GIF.");

  const extension = image.type === "image/jpeg" ? "jpg" : image.type.split("/")[1];
  const postId = crypto.randomUUID();
  const imageKey = `posts/${postId}.${extension}`;
  await env.FILES.put(imageKey, image.stream(), { httpMetadata: { contentType: image.type }, customMetadata: { owner: viewer.userId } });
  try {
    await env.DB.prepare(
      "INSERT INTO posts(id, user_id, description, image_key, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(postId, viewer.userId, description, imageKey, image.type, Date.now()).run();
  } catch (cause) {
    await env.FILES.delete(imageKey);
    throw cause;
  }
  return json({ ok: true, id: postId }, 201);
}

async function handleLike(request: Request, env: Env, postId: string): Promise<Response> {
  if (request.method !== "POST") return error("M筌?툓odo no permitido.", 405);
  const viewer = await getViewer(request, env.DB);
  if (!viewer) return error("Inicia sesi筌ｌ겖 para dar likes.", 401);
  const post = await env.DB.prepare("SELECT user_id FROM posts WHERE id = ?").bind(postId).first<{ user_id: string }>();
  if (!post) return error("La publicaci筌ｌ겖 no existe.", 404);
  if (post.user_id === viewer.userId) return error("No puedes dar like a tu propia publicaci筌ｌ겖.", 403);

  const existing = await env.DB.prepare("SELECT id FROM likes WHERE post_id = ? AND user_id = ?").bind(postId, viewer.userId).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE id = ?").bind(existing.id).run();
    return json({ liked: false, ...(await getLikeSummary(env.DB, viewer.userId)) });
  }
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO likes(id, post_id, user_id, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM likes WHERE user_id = ?) <
       COALESCE((SELECT limit_count FROM like_limits WHERE user_id = ?), (SELECT value FROM settings WHERE key = 'default_like_limit'), ?)`,
  ).bind(crypto.randomUUID(), postId, viewer.userId, Date.now(), viewer.userId, viewer.userId, DEFAULT_LIKE_LIMIT).run();
  if (!inserted.meta.changes) return error("Ya usaste todos los likes disponibles.", 409);
  return json({ liked: true, ...(await getLikeSummary(env.DB, viewer.userId)) });
}

async function handleAdmin(request: Request, env: Env, pathname: string): Promise<Response> {
  const viewer = await getViewer(request, env.DB);
  if (!viewer?.isAdmin) return error("Solo la administradora puede ver esta informaci筌ｌ겖.", 403);
  if (pathname === "/api/admin/users" && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT u.user_id, u.email, u.display_name, lim.limit_count AS custom_limit,
        COALESCE(lim.limit_count, (SELECT value FROM settings WHERE key = 'default_like_limit'), ?) AS like_limit,
        (SELECT COUNT(*) FROM likes given_likes WHERE given_likes.user_id = u.user_id) AS likes_given,
        (SELECT COUNT(*) FROM posts own_posts WHERE own_posts.user_id = u.user_id) AS posts_count,
        (SELECT COUNT(*) FROM likes received JOIN posts rp ON rp.id = received.post_id WHERE rp.user_id = u.user_id) AS likes_received
       FROM users u LEFT JOIN like_limits lim ON lim.user_id = u.user_id
       ORDER BY likes_received DESC, u.display_name COLLATE NOCASE`,
    ).bind(DEFAULT_LIKE_LIMIT).all();
    const setting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'default_like_limit'").first<{ value: number }>();
    return json({ defaultLikeLimit: Number(setting?.value ?? DEFAULT_LIKE_LIMIT), users: result.results });
  }
  if (pathname === "/api/admin/settings" && request.method === "PUT") {
    const body = await request.json<{ defaultLikeLimit?: number }>();
    const limit = Number(body.defaultLikeLimit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return error("El l筌?윮ite debe ser un n筌ｌ눗ero entero entre 0 y 1000.");
    await env.DB.prepare(
      "INSERT INTO settings(key, value) VALUES ('default_like_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(limit).run();
    return json({ ok: true, defaultLikeLimit: limit });
  }
  const userLimitMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/limit$/);
  if (userLimitMatch && request.method === "PUT") {
    const targetUserId = decodeURIComponent(userLimitMatch[1]);
    const body = await request.json<{ limit?: number | null }>();
    if (body.limit === null) {
      await env.DB.prepare("DELETE FROM like_limits WHERE user_id = ?").bind(targetUserId).run();
      return json({ ok: true });
    }
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return error("El l筌?윮ite debe ser un n筌ｌ눗ero entero entre 0 y 1000.");
    await env.DB.prepare(
      "INSERT INTO like_limits(user_id, limit_count) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET limit_count = excluded.limit_count",
    ).bind(targetUserId, limit).run();
    return json({ ok: true, limit });
  }
  return error("Ruta de administraci筌ｌ겖 no encontrada.", 404);
}

async function handleMedia(env: Env, postId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT image_key, content_type FROM posts WHERE id = ?").bind(postId).first<{ image_key: string; content_type: string }>();
  if (!row) return new Response("Not found", { status: 404 });
  const object = await env.FILES.get(row.image_key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", row.content_type);
  headers.set("cache-control", "public, max-age=86400");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(siteHtml, { headers: { "content-type": "text/html; charset=UTF-8" } });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
      const origin = request.headers.get("origin");
      if (request.method !== "GET" && request.method !== "HEAD" && origin && origin !== url.origin) {
        return error("Origen de solicitud no permitido.", 403);
      }
      try {
        await ensureSchema(env.DB);
        if (url.pathname === "/api/me") return await handleMe(request, env);
        if (url.pathname === "/api/posts") return await handlePosts(request, env);
        const likeMatch = url.pathname.match(/^\/api\/posts\/([^/]+)\/like$/);
        if (likeMatch) return await handleLike(request, env, decodeURIComponent(likeMatch[1]));
        if (url.pathname.startsWith("/api/admin/")) return await handleAdmin(request, env, url.pathname);
        const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
        if (mediaMatch) return await handleMedia(env, decodeURIComponent(mediaMatch[1]));
        return error("Ruta no encontrada.", 404);
      } catch (cause) {
        console.error(cause);
        return error("No se pudo completar la solicitud. Int筌?툊talo de nuevo.", 500);
      }
    }
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
