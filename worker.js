// Worker entry point — site này deploy dạng Cloudflare WORKER (domain
// *.onstudy.workers.dev), KHÔNG phải Cloudflare Pages, dù CLAUDE.md trước đây
// ghi nhầm là Pages. Phát hiện khi /api/create-parent trả về 404: thư mục
// functions/api/*.js theo quy ước "Pages Functions" bị Worker bỏ qua hoàn
// toàn — 2 sản phẩm khác nhau của Cloudflare, không tự nhận diện lẫn nhau.
//
// File này được khai báo làm "main" entry trong wrangler.jsonc (KHÔNG được đặt
// tên "_worker.js" — đó là tên dành riêng cho Cloudflare Pages, Wrangler sẽ từ
// chối deploy 1 Worker (không phải Pages) có file tên đó, báo lỗi "Uploading a
// Pages _worker.js file as an asset." — đã gặp lỗi này thật, đổi tên mới hết).
// Request nào không khớp route tự viết bên dưới thì rơi xuống phục vụ file
// tĩnh qua env.ASSETS.fetch() y hệt trước đây — không đổi hành vi các trang
// html/json/icon hiện có.
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

// Thông báo nhắc học — chạy theo lịch (xem "triggers.crons" trong wrangler.jsonc,
// 1 mốc giờ 20h tối giờ Việt Nam). Chỉ nhắc học sinh đã bật `profiles.reminder_enabled`
// VÀ chưa có hoạt động gì trong ngày hôm đó (RPC get_users_needing_reminder(), xem
// migration 34_migration_add_reminder_preference.sql). Gửi push qua OneSignal REST
// API thay vì tự viết Web Push/VAPID — xem lý do trong tài liệu bàn giao mục nhắc học.
async function sendStudyReminders(env) {
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const oneSignalAppId = env.ONESIGNAL_APP_ID;
  const oneSignalApiKey = env.ONESIGNAL_REST_API_KEY;
  if (!serviceRoleKey || !oneSignalAppId || !oneSignalApiKey) {
    console.error("Nhắc học: thiếu secret (SUPABASE_SERVICE_ROLE_KEY / ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY) — bỏ qua lần chạy này.");
    return;
  }

  const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_users_needing_reminder`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  });
  if (!rpcRes.ok) {
    console.error("Nhắc học: lỗi gọi get_users_needing_reminder — " + (await rpcRes.text()));
    return;
  }
  const rows = await rpcRes.json();
  const userIds = (rows || []).map((r) => r.user_id);
  if (userIds.length === 0) return;

  const notifyRes = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${oneSignalApiKey}`
    },
    body: JSON.stringify({
      app_id: oneSignalAppId,
      include_aliases: { external_id: userIds },
      target_channel: "push",
      headings: { en: "⏰ Đến giờ học rồi!" },
      contents: { en: "Hôm nay bạn chưa luyện tập — dành vài phút ôn bài trên iLapra nhé!" },
      url: "https://langprac.onstudy.workers.dev/app.html"
    })
  });
  if (!notifyRes.ok) {
    console.error("Nhắc học: gửi push qua OneSignal thất bại — " + (await notifyRes.text()));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create-parent") {
      // Bọc try/catch tạm thời để lỗi thật (message + stack) hiện thẳng ra
      // JSON trả về — không cần vào Cloudflare Dashboard tìm log nữa, xem
      // thẳng trong Console/Network của trình duyệt là đủ. Có thể bỏ lớp
      // try/catch này sau khi đã xác định và sửa xong lỗi gốc.
      try {
        return await handleCreateParent(request, env);
      } catch (err) {
        return jsonResponse({ error: "EXCEPTION: " + (err && err.message), stack: err && err.stack }, 500);
      }
    }

    // Mọi request khác: phục vụ file tĩnh y hệt trước đây (index.html,
    // app.html, manifest.json, icons/, languages.json...).
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendStudyReminders(env));
  }
};
