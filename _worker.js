// Worker entry point — site này deploy dạng Cloudflare WORKER (domain
// *.onstudy.workers.dev), KHÔNG phải Cloudflare Pages, dù CLAUDE.md trước đây
// ghi nhầm là Pages. Phát hiện khi /api/create-parent trả về 404: thư mục
// functions/api/*.js theo quy ước "Pages Functions" bị Worker bỏ qua hoàn
// toàn — 2 sản phẩm khác nhau của Cloudflare, không tự nhận diện lẫn nhau.
//
// _worker.js là quy ước CHUẨN để thêm route API tự viết vào 1 Worker đang
// phục vụ static assets: Cloudflare tự nhận diện file này ở gốc thư mục asset,
// chạy nó TRƯỚC, request nào không khớp route tự viết thì rơi xuống phục vụ
// file tĩnh qua env.ASSETS.fetch() y hệt trước đây — không đổi hành vi các
// trang html/json/icon hiện có.
//
// Logic tạo tài khoản phụ huynh giữ NGUYÊN VĂN từ functions/api/create-parent.js
// (file đó giờ không còn được dùng nữa vì không phải Pages — giữ lại chỉ để
// tham khảo nếu sau này chuyển sang host bằng Pages thật).

const SUPABASE_URL = "https://vuykuqmebmainyhiotfx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8Ro-jEFQqFh7EfbXPfzWaw_V1xrkoyU";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleCreateParent(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed, dùng POST." }, 405);
  }

  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return jsonResponse({ error: "Server chưa cấu hình SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) {
    return jsonResponse({ error: "Thiếu Authorization header." }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Body không hợp lệ (cần JSON)." }, 400);
  }
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || password.length < 6) {
    return jsonResponse({ error: "Cần email hợp lệ và mật khẩu tối thiểu 6 ký tự." }, 400);
  }

  // 1. Xác định người gọi là ai.
  const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${callerToken}` }
  });
  if (!callerRes.ok) {
    return jsonResponse({ error: "Không xác thực được người gọi." }, 401);
  }
  const caller = await callerRes.json();

  // 2. Kiểm tra người gọi có trong bảng admins không.
  const adminCheckRes = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?user_id=eq.${encodeURIComponent(caller.id)}&select=user_id`,
    { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
  );
  const adminRows = adminCheckRes.ok ? await adminCheckRes.json() : [];
  if (!adminRows.length) {
    return jsonResponse({ error: "Chỉ admin mới được tạo tài khoản phụ huynh." }, 403);
  }

  // 3. Tạo tài khoản Auth mới (Admin API — GoTrue).
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    return jsonResponse({ error: created.msg || created.error_description || "Tạo tài khoản thất bại." }, createRes.status);
  }

  // 4. Gán role='parent' trong profiles (trigger đã tự tạo dòng mặc định 'student').
  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${created.id}`, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({ role: "parent" })
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    return jsonResponse({ error: "Tạo tài khoản OK nhưng gán vai trò 'parent' thất bại: " + err }, 500);
  }
  const patched = await patchRes.json();
  if (!Array.isArray(patched) || patched.length === 0) {
    return jsonResponse({ error: "Tạo tài khoản OK nhưng không tìm thấy dòng profiles để gán vai trò 'parent' — thử liên kết lại sau vài giây, hoặc kiểm tra tay trong Supabase." }, 500);
  }

  return jsonResponse({ userId: created.id });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create-parent") {
      return handleCreateParent(request, env);
    }

    // Mọi request khác: phục vụ file tĩnh y hệt trước đây (index.html,
    // app.html, manifest.json, icons/, languages.json...).
    return env.ASSETS.fetch(request);
  }
};
