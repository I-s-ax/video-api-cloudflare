interface Env {
  DB: D1Database;
  BOOTSTRAP_SECRET: string;
  ADMIN_ORIGIN: string;
}

type UserRow = {
  id: string; email: string; password_hash: string; password_salt: string;
  role: string; status: string; created_at: number;
};

const encoder = new TextEncoder();
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });

const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID();

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = env.ADMIN_ORIGIN && origin === env.ADMIN_ORIGIN ? origin : "";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type,Authorization,X-Bootstrap-Secret",
    "vary": "Origin"
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function body<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 16_384) throw new Error("BODY_TOO_LARGE");
  return await request.json() as T;
}

async function createSession(env: Env, userId: string, deviceLabel?: string) {
  const token = randomToken();
  const created = now();
  await env.DB.prepare(
    "INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,device_label) VALUES (?,?,?,?,?,?)"
  ).bind(id(), userId, await sha256(token), created, created + 60 * 60 * 24 * 14, (deviceLabel || "").slice(0, 80)).run();
  return token;
}

async function authenticate(request: Request, env: Env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token.length > 200) return null;
  const tokenHash = await sha256(token);
  return await env.DB.prepare(
    `SELECT users.id, users.email, users.role, users.status, sessions.id AS session_id
     FROM sessions JOIN users ON users.id=sessions.user_id
     WHERE sessions.token_hash=? AND sessions.revoked_at IS NULL
       AND sessions.expires_at>?`
  ).bind(tokenHash, now()).first<any>();
}

async function requireApproved(request: Request, env: Env) {
  const user = await authenticate(request, env);
  if (!user) return { error: json({ error: "UNAUTHORIZED" }, 401), user: null };
  if (user.status !== "approved" && user.role !== "admin") {
    return { error: json({ error: "ACCOUNT_NOT_APPROVED", status: user.status }, 403), user: null };
  }
  return { error: null, user };
}

async function requireAdmin(request: Request, env: Env) {
  const result = await requireApproved(request, env);
  if (result.error) return result;
  if (result.user.role !== "admin") return { error: json({ error: "FORBIDDEN" }, 403), user: null };
  return result;
}

function allowedPlatform(urlString: string): string | null {
  let url: URL;
  try { url = new URL(urlString); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const domains: Record<string, string[]> = {
    facebook: ["facebook.com", "fb.watch", "m.facebook.com"],
    tiktok: ["tiktok.com"],
    instagram: ["instagram.com"],
    x: ["x.com", "twitter.com", "t.co"]
  };
  for (const [platform, hosts] of Object.entries(domains)) {
    if (hosts.some(h => host === h || host.endsWith("." + h))) return platform;
  }
  return null;
}

async function logAdmin(env: Env, adminId: string, target: string | null, action: string) {
  await env.DB.prepare("INSERT INTO admin_logs (id,admin_id,target_user_id,action,created_at) VALUES (?,?,?,?,?)")
    .bind(id(), adminId, target, action, now()).run();
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  if (method === "GET" && path === "/health") return json({ ok: true, service: "video-api", version: "0.1.0" });

  if (method === "POST" && path === "/admin/bootstrap") {
    if (!env.BOOTSTRAP_SECRET || request.headers.get("X-Bootstrap-Secret") !== env.BOOTSTRAP_SECRET) {
      return json({ error: "INVALID_BOOTSTRAP_SECRET" }, 401);
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first<{n:number}>();
    if ((count?.n || 0) > 0) return json({ error: "BOOTSTRAP_ALREADY_USED" }, 409);
    const input = await body<{email:string; password:string}>(request);
    const email = (input.email || "").trim().toLowerCase();
    const password = input.password || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
      return json({ error: "EMAIL_INVALID_OR_PASSWORD_TOO_SHORT" }, 400);
    }
    const salt = randomToken();
    const userId = id();
    await env.DB.prepare(
      "INSERT INTO users (id,email,password_hash,password_salt,role,status,created_at,updated_at,approved_at) VALUES (?,?,?,?, 'admin','approved',?,?,?)"
    ).bind(userId,email,await passwordHash(password,salt),salt,now(),now(),now()).run();
    return json({ ok: true, message: "Admin creado. Guarda el acceso de forma segura." }, 201);
  }

  if (method === "POST" && path === "/auth/register") {
    const input = await body<{email:string;password:string;device_label?:string}>(request);
    const email = (input.email || "").trim().toLowerCase();
    const password = input.password || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
      return json({ error: "EMAIL_INVALID_OR_PASSWORD_MIN_12" }, 400);
    }
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (exists) return json({ error: "EMAIL_ALREADY_REGISTERED" }, 409);
    const salt = randomToken();
    const userId = id();
    await env.DB.prepare(
      "INSERT INTO users (id,email,password_hash,password_salt,role,status,created_at,updated_at) VALUES (?,?,?,?,'user','pending',?,?)"
    ).bind(userId,email,await passwordHash(password,salt),salt,now(),now()).run();
    return json({ ok: true, status: "pending", message: "Cuenta creada. Espera aprobación del administrador." }, 201);
  }

  if (method === "POST" && path === "/auth/login") {
    const input = await body<{email:string;password:string;device_label?:string}>(request);
    const email = (input.email || "").trim().toLowerCase();
    const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<UserRow>();
    if (!user || await passwordHash(input.password || "", user.password_salt) !== user.password_hash) {
      return json({ error: "INVALID_CREDENTIALS" }, 401);
    }
    if (["suspended","rejected","revoked"].includes(user.status)) {
      return json({ error: "ACCOUNT_UNAVAILABLE", status: user.status }, 403);
    }
    const token = await createSession(env, user.id, input.device_label);
    return json({ token, token_type: "Bearer", expires_in: 1209600, user: { id:user.id,email:user.email,role:user.role,status:user.status } });
  }

  if (method === "GET" && path === "/api/v1/platforms") {
    return json({ platforms: ["facebook","tiktok","instagram","x"], note: "Disponibilidad sujeta a compatibilidad del extractor y acceso público." });
  }

  if (path.startsWith("/admin/") && path !== "/admin/bootstrap") {
    const auth = await requireAdmin(request, env);
    if (auth.error) return auth.error;
    const admin = auth.user;
    if (method === "GET" && path === "/admin/users") {
      const rows = await env.DB.prepare(
        "SELECT id,email,role,status,created_at,approved_at FROM users ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200"
      ).all();
      return json({ users: rows.results || [] });
    }
    const match = path.match(/^\/admin\/users\/([a-f0-9-]+)\/(approve|reject|suspend|revoke)$/i);
    if (method === "POST" && match) {
      const [, targetId, action] = match;
      if (targetId === admin.id) return json({ error: "CANNOT_CHANGE_OWN_ACCOUNT" }, 400);
      const statusMap: Record<string,string> = { approve:"approved", reject:"rejected", suspend:"suspended", revoke:"revoked" };
      const status = statusMap[action];
      const result = await env.DB.prepare("UPDATE users SET status=?, updated_at=?, approved_at=? WHERE id=? AND role='user'")
        .bind(status,now(),action === "approve" ? now() : null,targetId).run();
      if (!result.meta.changes) return json({ error: "USER_NOT_FOUND" }, 404);
      if (action !== "approve") {
        await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").bind(now(),targetId).run();
      }
      await logAdmin(env,admin.id,targetId,action);
      return json({ ok:true,status });
    }
  }

  if (method === "POST" && path === "/auth/logout") {
    const user = await authenticate(request, env);
    if (!user) return json({ error:"UNAUTHORIZED" },401);
    await env.DB.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").bind(now(),user.session_id).run();
    return json({ ok:true });
  }

  if (method === "GET" && path === "/auth/me") {
    const user = await authenticate(request, env);
    if (!user) return json({ error:"UNAUTHORIZED" },401);
    return json({ id:user.id,email:user.email,role:user.role,status:user.status });
  }

  if (method === "GET" && path === "/api/v1/history") {
    const auth = await requireApproved(request,env);
    if (auth.error) return auth.error;
    const rows = await env.DB.prepare(
      "SELECT id,platform,status,created_at FROM extraction_history WHERE user_id=? ORDER BY created_at DESC LIMIT 50"
    ).bind(auth.user.id).all();
    return json({ history: rows.results || [] });
  }

  if (method === "POST" && path === "/api/v1/extract") {
    const auth = await requireApproved(request,env);
    if (auth.error) return auth.error;
    const input = await body<{url:string}>(request);
    const platform = allowedPlatform(input.url || "");
    if (!platform) return json({ error:"UNSUPPORTED_OR_INVALID_URL" },400);
    const since = now() - 60;
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM extraction_history WHERE user_id=? AND created_at>=?"
    ).bind(auth.user.id,since).first<{n:number}>();
    if ((count?.n || 0) >= 5) return json({ error:"RATE_LIMITED", retry_after:60 },429);
    await env.DB.prepare("INSERT INTO extraction_history (id,user_id,platform,status,created_at) VALUES (?,?,?,?,?)")
      .bind(id(),auth.user.id,platform,"not_configured",now()).run();
    return json({
      error:"EXTRACTOR_NOT_CONFIGURED",
      platform,
      message:"La autenticación funciona, pero el adaptador de extracción aún no está conectado."
    },501);
  }

  return json({ error:"NOT_FOUND" },404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await handle(request, env);
      const headers = new Headers(response.headers);
      const cors = corsHeaders(request,env);
      for (const [key,value] of Object.entries(cors)) if (value) headers.set(key,value);
      headers.set("x-content-type-options","nosniff");
      headers.set("referrer-policy","no-referrer");
      headers.set("cache-control","no-store");
      return new Response(response.body,{status:response.status,headers});
    } catch (error) {
      console.error("request_error", error instanceof Error ? error.message : "unknown");
      return json({error:"INTERNAL_ERROR"},500);
    }
  }
};
